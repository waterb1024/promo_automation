"""
Promotion Automation Helper - Phase 1 통합
- /health             : 헬스체크
- /package            : zip 만 생성 (dry-run/검수용)
- /package_and_upload : zip + Way 첨부 + 댓글 (메인 워크플로우)

scripts/ 모듈을 통해 jira_client / revision / zip_utils / config 재사용.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import re
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from PIL import Image

from scripts.config import load_config, ConfigError, DEFAULT_OUTPUT
from scripts.jira_client import JiraClient, JiraError
from scripts.ppt_renderer import (
    pptx_to_slide_pngs,
    pptx_extract_texts,
    pptx_extract_texts_grouped,
    PPTRenderError,
)
from scripts.revision import decide as decide_revision
from scripts.zip_utils import write_utf8_zip


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("promo-helper")

app = FastAPI(title="Promotion Automation Helper", version="0.2.0")

# Figma plugin iframe origin은 "null" — 와일드카드 허용 (로컬 전용 서비스)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# config 는 Helper 기동 시점에 로드. 변경 시 launchctl unload/load 로 재기동 필요.
try:
    CONFIG = load_config()
    log.info("config 로드 OK (way_base_url=%s, output_dir=%s)",
             CONFIG.way_base_url, CONFIG.output_dir)
except ConfigError as e:
    CONFIG = None
    log.warning("config 로드 실패: %s — /package_and_upload 호출은 503 으로 응답합니다.", e)

OUTPUT_DIR = (CONFIG.output_dir if CONFIG else DEFAULT_OUTPUT)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

COMMENT_TEMPLATES_PATH = Path(__file__).resolve().parent / "comment_templates.json"

# 파일명 또는 "폴더/(폴더/)파일명" 2단계 까지 허용. 폴더명·파일명 모두 안전 문자만.
SAFE_FILENAME_RE = re.compile(
    r"^(?:[\w가-힣\-. ]+/){0,2}[\w가-힣\-. ]+\.(png|jpg|jpeg)$",
    re.IGNORECASE,
)


# -------- Pydantic 모델 --------

class FileEntry(BaseModel):
    filename: str
    base64: str


class Counts(BaseModel):
    banner: int = 0
    popup: int = 0
    landing: int = 0


class Metadata(BaseModel):
    date: str = Field(..., description="MMDD")
    promotion: str
    counts: Counts


class SplitSegment(BaseModel):
    start: int   # 메인 frame 기준 Y 좌표 (Figma 단위)
    end: int


class SplitSpec(BaseModel):
    """
    files 안의 어떤 PNG 한 장을 Y좌표 기준으로 잘라서 추가 PNG들을 생성하라는 지시.
    """
    main_filename: str          # 자를 메인 PNG 의 파일명 (files 에 반드시 포함되어야)
    frame_height: int           # 메인 frame 의 height (Figma 단위) — 좌표 정규화용
    segments: List[SplitSegment]


class PackageRequest(BaseModel):
    files: List[FileEntry]
    metadata: Metadata
    splits: Optional[List[SplitSpec]] = None  # 검수용 zip 에도 동일한 분할 적용


class PackageAndUploadRequest(BaseModel):
    files: List[FileEntry]
    metadata: Metadata
    jira_key: str
    splits: Optional[List[SplitSpec]] = None  # 있으면 PIL crop 으로 분할 PNG 추가


class ImportPPTRequest(BaseModel):
    jira_key: str


class GenerateImageRequest(BaseModel):
    texts: List[str] = Field(default_factory=list, description="팝업/배너의 텍스트들 (위→아래 순). 프롬프트 생성에 사용")
    width: int = Field(..., ge=64, le=4096, description="채울 사각형의 width (px)")
    height: int = Field(..., ge=64, le=4096, description="채울 사각형의 height (px)")
    kind: str = Field("popup", description="popup | banner — 톤·스타일 힌트")
    extra_hint: Optional[str] = Field(None, description="사용자가 직접 추가하는 스타일/제약 힌트 (선택)")


# -------- 유틸 --------

def _safe_filename(name: str) -> str:
    # 백슬래시·경로 탈출은 차단. 폴더는 2단계까지 허용.
    if "\\" in name or ".." in name:
        raise HTTPException(400, f"잘못된 파일명: {name}")
    if name.count("/") > 2:
        raise HTTPException(400, f"폴더 2단계까지만 허용: {name}")
    if not SAFE_FILENAME_RE.match(name):
        raise HTTPException(400, f"허용되지 않은 파일명 형식: {name}")
    return name


def _build_entries(files: List[FileEntry]):
    entries = []
    for f in files:
        safe = _safe_filename(f.filename)
        try:
            data = base64.b64decode(f.base64, validate=True)
        except Exception as e:
            raise HTTPException(400, f"base64 디코드 실패: {f.filename} ({e})")
        entries.append((safe, data))
    return entries


def _organize_landing_folders(files: List[FileEntry]) -> List[FileEntry]:
    """
    landing 관련 PNG 를 한 폴더에 평평하게 정리 + Y좌표 순으로 글로벌 재번호:

      0515_landing_..._1080/
        ├─ 0515_landing_..._1080.png   ← 메인
        ├─ img_01.png                   ← 자식 1 의 분할 1 (또는 PIL 분할 1)
        ├─ img_02.png                   ← 자식 1 의 분할 2 (자식 1 이 추가 분할됐다면)
        ├─ img_03.png                   ← 자식 2 (또는 PIL 분할 3)
        └─ img_04.png                   ← 자식 3

    분할된 자식은 그 자리에 sub들이 펼쳐지고, 뒤의 자식들은 글로벌 카운트가 밀림.
    """
    LANDING_MAIN = re.compile(r"^(\d{4}_landing_.+?_\d+)\.png$")
    LANDING_SUB = re.compile(r"^(\d{4}_landing_.+?_\d+)_img_(\d+)\.png$")
    LANDING_SUB_SPLIT = re.compile(
        r"^(\d{4}_landing_.+?_\d+)_img_(\d+)/img_(\d+)\.png$"
    )
    LANDING_PIL_SPLIT = re.compile(r"^(\d{4}_landing_.+?_\d+)/img_(\d+)\.png$")

    # landing 별로 자료 정리
    # landings[base] = {
    #   "main":     FileEntry | None,
    #   "pil":      [(sub_idx:int, FileEntry), ...]            (Case B 자동 분할)
    #   "children": {child_idx:int → {"original": FileEntry | None,
    #                                  "splits":   [(sub_idx, FileEntry), ...]}}
    # }
    landings = {}
    other_files = []

    for f in files:
        m_ss = LANDING_SUB_SPLIT.match(f.filename)
        if m_ss:
            base = m_ss.group(1)
            ci = int(m_ss.group(2))
            si = int(m_ss.group(3))
            ld = landings.setdefault(
                base, {"main": None, "pil": [], "children": {}}
            )
            ch = ld["children"].setdefault(ci, {"original": None, "splits": []})
            ch["splits"].append((si, f))
            continue

        m_pil = LANDING_PIL_SPLIT.match(f.filename)
        if m_pil:
            base = m_pil.group(1)
            si = int(m_pil.group(2))
            ld = landings.setdefault(
                base, {"main": None, "pil": [], "children": {}}
            )
            ld["pil"].append((si, f))
            continue

        if "/" in f.filename:
            # 다른 폴더 안 — 우리가 모르는 패턴, 그대로 유지
            other_files.append(f)
            continue

        m_sub = LANDING_SUB.match(f.filename)
        if m_sub:
            base = m_sub.group(1)
            ci = int(m_sub.group(2))
            ld = landings.setdefault(
                base, {"main": None, "pil": [], "children": {}}
            )
            ch = ld["children"].setdefault(ci, {"original": None, "splits": []})
            ch["original"] = f
            continue

        m_main = LANDING_MAIN.match(f.filename)
        if m_main:
            base = m_main.group(1)
            ld = landings.setdefault(
                base, {"main": None, "pil": [], "children": {}}
            )
            ld["main"] = f
            continue

        other_files.append(f)

    if not landings:
        return files

    result = list(other_files)

    for base, info in landings.items():
        # 메인 PNG
        if info["main"] is not None:
            result.append(FileEntry(
                filename=f"{base}/{info['main'].filename}",
                base64=info["main"].base64,
            ))

        # 자식 frame Case (A): 자식 idx 순으로 글로벌 카운트
        if info["children"]:
            global_idx = 1
            for ci in sorted(info["children"].keys()):
                ch = info["children"][ci]
                if ch["splits"]:
                    # 추가 분할 — sub idx 순서대로 펼침 (원본은 제외)
                    for _, fe in sorted(ch["splits"]):
                        result.append(FileEntry(
                            filename=f"{base}/img_{global_idx:02d}.png",
                            base64=fe.base64,
                        ))
                        global_idx += 1
                elif ch["original"] is not None:
                    # 분할 안 된 자식
                    result.append(FileEntry(
                        filename=f"{base}/img_{global_idx:02d}.png",
                        base64=ch["original"].base64,
                    ))
                    global_idx += 1

        # PIL 자동 분할 Case (B): sub idx 순으로 글로벌 카운트
        if info["pil"]:
            for idx, (_, fe) in enumerate(sorted(info["pil"]), 1):
                result.append(FileEntry(
                    filename=f"{base}/img_{idx:02d}.png",
                    base64=fe.base64,
                ))

    return result


def _find_safe_cut_y(img: Image.Image, target_y: int,
                     search_range: int = 200,
                     min_y: int = 0, max_y: Optional[int] = None) -> int:
    """
    target_y 부근(±search_range)에서 색 변화가 가장 적은 가로 row 의 Y 좌표를 반환.
    글자나 이미지 중간이 잘리지 않게 분할점을 "빈 공간" 으로 이동시키기 위한 함수.

    동작:
      - 가로 row 마다 W/50 간격으로 픽셀을 샘플링
      - 그 row 안의 unique color 수가 가장 적은 곳을 "단색에 가까운 row" 로 판단
      - 단색이면 그 row 는 보통 배경의 빈 공간 → 안전한 분할 위치
    """
    W, H = img.size
    if max_y is None:
        max_y = H - 1

    y_lo = max(min_y, target_y - search_range)
    y_hi = min(max_y, target_y + search_range)
    if y_lo >= y_hi:
        return target_y

    # 픽셀 빠르게 읽기 위해 PixelAccess 객체 한 번만 가져옴
    px = img.load()
    sample_xs = list(range(0, W, max(1, W // 50)))

    best_y = target_y
    best_score = float("inf")
    # 2px step 으로 검색 (정확도와 속도의 균형)
    for y in range(y_lo, y_hi + 1, 2):
        colors = set()
        for x in sample_xs:
            colors.add(px[x, y])
        score = len(colors)
        if score < best_score:
            best_score = score
            best_y = y
            if score <= 2:
                # 거의 단색 — 더 좋은 위치는 없을 가능성 큼
                break
    return best_y


def _apply_splits(files: List[FileEntry], splits: Optional[List[SplitSpec]]) -> List[FileEntry]:
    """
    splits 가 있으면 각 spec 의 메인 PNG 를 PIL 로 열어 segment 별 crop → 새 PNG 들 생성.
    원본은 그대로 두고 새 entry 만 끝에 추가. (메인 + 분할 PNG 모두 zip 에 들어감)

    좌표 정규화:
      Plugin 이 보내는 segment 좌표는 Figma frame 좌표계 (frame 의 width/height 기준).
      실제 export 된 PNG 는 그 frame 을 scale 해서 만든 것이므로 PNG 의 height 가
      frame_height 와 같지 않을 수 있다. 그래서 비율로 변환:
          py_start = round(PNG_height * seg.start / frame_height)
    """
    if not splits:
        return files

    by_name = {f.filename: f.base64 for f in files}
    result = list(files)

    for spec in splits:
        if spec.main_filename not in by_name:
            log.warning("[split] main_filename '%s' 가 files 에 없음 — skip",
                        spec.main_filename)
            continue
        try:
            img_bytes = base64.b64decode(by_name[spec.main_filename])
            img = Image.open(io.BytesIO(img_bytes))
        except Exception as e:
            log.warning("[split] '%s' 열기 실패: %s — skip", spec.main_filename, e)
            continue

        png_w, png_h = img.size
        frame_h = max(spec.frame_height, 1)
        base_name = spec.main_filename.rsplit(".", 1)[0]

        log.info(
            "[split] %s (PNG %dx%d, frame_h=%d) → %d 개 segment 로 자름",
            spec.main_filename, png_w, png_h, frame_h, len(spec.segments),
        )

        MAX_PNG_HEIGHT = 3000   # crop 결과가 이보다 크면 균등 N등분으로 추가 분할
        img_idx = 1             # 결과 PNG 글로벌 카운터 (img_01, img_02, ...)

        for seg_i, seg in enumerate(spec.segments, 1):
            py_start = max(0, int(round(png_h * seg.start / frame_h)))
            py_end = min(png_h, int(round(png_h * seg.end / frame_h)))
            if py_end <= py_start:
                log.warning("[split]   seg #%d 폭 0 — skip (start=%d end=%d)",
                            seg_i, seg.start, seg.end)
                continue

            seg_height = py_end - py_start

            # 3000px 초과 시 균등 분할 + 글자/이미지 안 잘리게 단색 row 로 분할점 이동
            if seg_height > MAX_PNG_HEIGHT:
                import math
                n_subs = math.ceil(seg_height / MAX_PNG_HEIGHT)
                base_h = seg_height // n_subs
                rem = seg_height % n_subs

                # 1) 균등 분할 위치들 계산 (n_subs-1 개의 분할점)
                ideal_cuts = []
                offset = py_start
                for k in range(n_subs - 1):
                    h = base_h + (1 if k < rem else 0)
                    offset += h
                    ideal_cuts.append(offset)

                # 2) 각 분할점을 ±200px 안에서 단색 row 로 이동 (글자 안 잘리게)
                SEARCH = 200
                MARGIN = 50  # 너무 짧은 sub-segment 방지
                actual_cuts = []
                prev_y = py_start
                for ideal in ideal_cuts:
                    safe = _find_safe_cut_y(
                        img,
                        target_y=ideal,
                        search_range=SEARCH,
                        min_y=prev_y + MARGIN,
                        max_y=py_end - MARGIN,
                    )
                    actual_cuts.append(safe)
                    prev_y = safe

                # 3) ranges 구성
                ranges = []
                prev = py_start
                for cut in actual_cuts:
                    ranges.append((prev, cut))
                    prev = cut
                ranges.append((prev, py_end))

                log.info(
                    "[split]   seg #%d (%dpx) > %dpx → %d 등분 (단색 row 보정 적용)",
                    seg_i, seg_height, MAX_PNG_HEIGHT, n_subs,
                )
                for ci, ic in enumerate(ideal_cuts):
                    ac = actual_cuts[ci]
                    delta = ac - ic
                    if delta != 0:
                        log.info(
                            "[split]     cut #%d: ideal=%dpx → safe=%dpx (이동 %+dpx)",
                            ci + 1, ic, ac, delta,
                        )
            else:
                ranges = [(py_start, py_end)]

            for (s, e) in ranges:
                cropped = img.crop((0, s, png_w, e))
                buf = io.BytesIO()
                cropped.save(buf, format="PNG")
                cropped_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

                # zip 안에 "{base_name}/img_NN.png" 로 들어가 별도 폴더로 묶임
                idx_str = f"{img_idx:02d}"
                new_filename = f"{base_name}/img_{idx_str}.png"
                result.append(FileEntry(filename=new_filename, base64=cropped_b64))
                img_idx += 1

    return result


def _format_counts(counts) -> str:
    """
    counts 객체를 자연어 문자열로 조합. 0개인 타입은 제외.

    예) banner=1, popup=1, landing=1 → "배너1개, 팝업1개, 랜딩페이지1개"
    예) banner=0, popup=2, landing=1 → "팝업2개, 랜딩페이지1개"
    예) banner=2, popup=0, landing=0 → "배너2개"
    예) 모두 0                       → "시안"
    """
    parts = []
    if counts.banner > 0:
        parts.append(f"배너{counts.banner}개")
    if counts.popup > 0:
        parts.append(f"팝업{counts.popup}개")
    if counts.landing > 0:
        parts.append(f"랜딩페이지{counts.landing}개")
    return ", ".join(parts) if parts else "시안"


def _get_jira_client() -> JiraClient:
    if CONFIG is None:
        raise HTTPException(
            503,
            "config 가 로드되지 않았습니다. "
            "~/Documents/.promo-export/config.json 작성 후 "
            "`launchctl unload ~/Library/LaunchAgents/com.konai.promo-automation.plist && "
            "launchctl load ~/Library/LaunchAgents/com.konai.promo-automation.plist` "
            "로 Helper 재기동.",
        )
    return JiraClient(
        base_api_url=CONFIG.way_api_base,
        session_login_url=CONFIG.way_session_url,
        pat=CONFIG.way_pat,
        username=CONFIG.way_username,
        password=CONFIG.way_password,
    )


# -------- 엔드포인트 --------

@app.get("/health")
def health():
    import os as _os
    return {
        "ok": True,
        "version": app.version,
        "config_loaded": CONFIG is not None,
        "output_dir": str(OUTPUT_DIR),
        "way_base_url": CONFIG.way_base_url if CONFIG else None,
        "way_auth": (
            "pat" if (CONFIG and CONFIG.way_pat)
            else ("basic" if (CONFIG and CONFIG.way_username) else "none")
        ),
        "openai_loaded": bool(CONFIG and CONFIG.openai_api_key),
        "openai_env_present": "OPENAI_API_KEY" in _os.environ,
    }


@app.post("/package")
def package(req: PackageRequest):
    """zip 만 만든다 — Way 호출 없음. dry-run / 검수용."""
    if not req.files:
        raise HTTPException(400, "파일이 비어 있습니다.")
    base = f"{req.metadata.date}_{req.metadata.promotion}"
    zip_path = OUTPUT_DIR / f"{base}.zip"
    if zip_path.exists():
        ts = datetime.now().strftime("%H%M%S")
        zip_path = OUTPUT_DIR / f"{base}_{ts}.zip"

    # 분할 spec 이 있으면 PIL crop 으로 PNG 추가 (검수용 zip 에도 동일하게 적용)
    expanded_files = _apply_splits(req.files, req.splits)
    if len(expanded_files) != len(req.files):
        log.info(
            "[package] split 처리 결과: %d 파일 → %d 파일",
            len(req.files), len(expanded_files),
        )

    # landing 메인 + 자식 PNG 를 한 폴더로 묶기
    expanded_files = _organize_landing_folders(expanded_files)

    log.info("[package] zip 생성 시작: %s (files=%d)", zip_path, len(expanded_files))
    entries = _build_entries(expanded_files)
    bytes_written = write_utf8_zip(zip_path, entries)
    log.info("[package] 완료: %s (%d bytes)", zip_path, bytes_written)
    return {
        "ok": True,
        "zip_path": str(zip_path),
        "file_count": len(entries),
        "bytes": bytes_written,
    }


@app.post("/package_and_upload")
def package_and_upload(req: PackageAndUploadRequest):
    """zip 생성 → Way 이슈에 첨부 + 댓글 등록. 메인 워크플로우."""
    if not req.files:
        raise HTTPException(400, "파일이 비어 있습니다.")

    # 0) 분할 spec 이 있으면 PIL crop 으로 PNG 추가
    expanded_files = _apply_splits(req.files, req.splits)
    if len(expanded_files) != len(req.files):
        log.info(
            "[upload] split 처리 결과: %d 파일 → %d 파일",
            len(req.files), len(expanded_files),
        )

    # landing 메인 + 자식 PNG 를 한 폴더로 묶기
    expanded_files = _organize_landing_folders(expanded_files)

    jira = _get_jira_client()

    # 1) Way 이슈 조회 — reporter + 기존 첨부
    log.info("[upload] Way 이슈 조회: %s", req.jira_key)
    try:
        issue = jira.get_issue(req.jira_key)
    except JiraError as e:
        raise HTTPException(502, f"Way 이슈 조회 실패: {e}")

    # 2) 수정본 자동 판별 + zip 파일명 결정
    existing_zips = [a.filename for a in issue.attachments]
    decision = decide_revision(
        req.metadata.date, req.metadata.promotion, existing_zips
    )
    zip_path = OUTPUT_DIR / decision.zip_filename
    log.info(
        "[upload] zip 파일명 결정: %s (revision=%s, index=%d, 기존 첨부=%d개)",
        decision.zip_filename, decision.is_revision, decision.revision_index,
        len(existing_zips),
    )

    # 3) zip 생성 (분할 처리된 expanded_files 사용)
    entries = _build_entries(expanded_files)
    bytes_written = write_utf8_zip(zip_path, entries)
    log.info("[upload] zip 생성 OK: %s (%d bytes, %d files)",
             zip_path, bytes_written, len(entries))

    # 4) Way 첨부
    log.info("[upload] Way 첨부 업로드 → %s", req.jira_key)
    try:
        jira.upload_attachment(req.jira_key, zip_path)
    except JiraError as e:
        raise HTTPException(502, f"Way 첨부 업로드 실패: {e}")

    # 5) 댓글 등록 (템플릿 + reporter 멘션)
    templates = json.loads(COMMENT_TEMPLATES_PATH.read_text(encoding="utf-8"))
    tpl_key = "revision" if decision.is_revision else "first_upload"
    tpl = templates[tpl_key]
    mention = (
        f"[~{issue.reporter_username}]" if issue.reporter_username else "@reporter"
    )
    counts_text = _format_counts(req.metadata.counts)
    comment = tpl.format(
        mention=mention,
        counts_text=counts_text,
        banner=req.metadata.counts.banner,
        popup=req.metadata.counts.popup,
        landing=req.metadata.counts.landing,
        date=req.metadata.date,
        promotion=req.metadata.promotion,
        zip_filename=decision.zip_filename,
    )
    log.info("[upload] 댓글 등록 중...")
    try:
        jira.add_comment(req.jira_key, comment)
    except JiraError as e:
        raise HTTPException(502, f"Way 댓글 등록 실패: {e}")

    log.info("[upload] 완료: issue=%s, zip=%s", req.jira_key, decision.zip_filename)
    return {
        "ok": True,
        "zip_path": str(zip_path),
        "zip_filename": decision.zip_filename,
        "is_revision": decision.is_revision,
        "revision_index": decision.revision_index,
        "file_count": len(entries),
        "bytes": bytes_written,
        "issue_key": req.jira_key,
        "reporter_username": issue.reporter_username,
        "reporter_display": issue.reporter_display,
        "counts": req.metadata.counts.model_dump(),
        "comment": comment,
    }


@app.post("/issue/load_ppt")
def load_ppt(req: ImportPPTRequest):
    """
    Way 이슈의 PPT 첨부를 슬라이드별 PNG 로 변환해서 반환.
    Plugin 이 받아서 Figma 캔버스에 자동 배치.
    """
    from datetime import datetime

    jira = _get_jira_client()
    log.info("[load_ppt] 이슈 조회: %s", req.jira_key)
    try:
        issue = jira.get_issue(req.jira_key)
    except JiraError as e:
        raise HTTPException(502, f"Way 이슈 조회 실패: {e}")

    # PPT 첨부 찾기
    ppt_att = next(
        (a for a in issue.attachments
         if a.filename.lower().endswith((".pptx", ".ppt"))),
        None,
    )
    if not ppt_att:
        raise HTTPException(404, "이슈에 PPT 첨부가 없습니다.")

    log.info("[load_ppt] PPT 다운로드: %s (%d bytes)",
             ppt_att.filename, ppt_att.size)
    try:
        ppt_bytes = jira.download_attachment(ppt_att.content_url)
    except JiraError as e:
        raise HTTPException(502, f"PPT 다운로드 실패: {e}")

    log.info("[load_ppt] LibreOffice + poppler 로 변환 시작")
    try:
        slides = pptx_to_slide_pngs(ppt_bytes, dpi=150)
    except PPTRenderError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, f"PPT 변환 실패: {e}")

    # 슬라이드별 텍스트 추출 (LibreOffice 폰트 무관, python-pptx 가 원본 데이터 사용)
    try:
        slide_texts = pptx_extract_texts(ppt_bytes)
    except Exception as e:
        log.warning("[load_ppt] 텍스트 추출 실패 (계속 진행): %s", e)
        slide_texts = []

    # 슬라이드별 mockup 영역 단위로 텍스트 그룹화 (위치 클러스터링)
    try:
        slide_text_groups = pptx_extract_texts_grouped(ppt_bytes)
    except Exception as e:
        log.warning("[load_ppt] 영역 그룹화 실패 (계속 진행): %s", e)
        slide_text_groups = []

    log.info(
        "[load_ppt] 변환 완료: %d 슬라이드, 텍스트 평탄 %d, 영역 그룹 %d",
        len(slides), len(slide_texts), len(slide_text_groups),
    )

    return {
        "ok": True,
        "issue_key": issue.key,
        "summary": issue.summary,
        "reporter": {
            "username": issue.reporter_username,
            "display": issue.reporter_display,
        },
        "assignee": {
            "username": issue.assignee_username,
            "display": issue.assignee_display,
        },
        "ppt_filename": ppt_att.filename,
        "today_mmdd": datetime.now().strftime("%m%d"),
        "slides": [
            {
                "index": s["index"],
                "width": s["width"],
                "height": s["height"],
                "base64": base64.b64encode(s["bytes"]).decode("ascii"),
                "texts": slide_texts[i] if i < len(slide_texts) else [],
                # 영역(네모) 단위 텍스트 그룹 — plugin 이 sub-frame 으로 분리
                "text_groups": (
                    slide_text_groups[i] if i < len(slide_text_groups) else []
                ),
            }
            for i, s in enumerate(slides)
        ],
    }


# gpt-image-1 이 지원하는 size — request 받은 width/height 에서 비율로 가장 가까운 값 선택.
# 정사각 / 세로(portrait) / 가로(landscape) 3종만 허용됨.
_GPT_IMAGE_SIZES = [
    (1024, 1024),
    (1024, 1536),
    (1536, 1024),
]


def _pick_gpt_image_size(w: int, h: int) -> str:
    target = w / max(h, 1)
    best = min(_GPT_IMAGE_SIZES, key=lambda s: abs((s[0] / s[1]) - target))
    return f"{best[0]}x{best[1]}"


def _extract_dominant_color_pastel(png_bytes: bytes,
                                   l_min: float = 0.87,
                                   l_max: float = 0.93) -> Optional[str]:
    """
    Transparent-background PNG 에서 불투명 픽셀들의 dominant color 를 추출하고
    HSL Lightness 를 [l_min, l_max] 로 클램프해서 hex(#RRGGBB) 로 반환.
    실패 시 None.
    """
    import colorsys
    try:
        img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
        img.thumbnail((64, 64))
        opaque = [(r, g, b) for (r, g, b, a) in img.getdata() if a >= 200]
        if not opaque:
            return None

        # PIL median-cut 으로 5색 팔레트 → 가장 많이 사용된 색 인덱스
        flat = Image.new("RGB", (len(opaque), 1))
        flat.putdata(opaque)
        quant = flat.quantize(colors=5)
        counts = quant.getcolors() or []
        if not counts:
            return None
        counts.sort(reverse=True)
        _, idx = counts[0]
        pal = quant.getpalette() or []
        r, g, b = pal[idx * 3], pal[idx * 3 + 1], pal[idx * 3 + 2]

        # RGB → HLS (Python 표준 라이브러리는 HLS 이름이지만 HSL 과 동일 모델)
        rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
        h, l, s = colorsys.rgb_to_hls(rf, gf, bf)
        l = max(l_min, min(l_max, l))
        r2, g2, b2 = colorsys.hls_to_rgb(h, l, s)
        return "#{:02x}{:02x}{:02x}".format(
            int(round(r2 * 255)), int(round(g2 * 255)), int(round(b2 * 255))
        )
    except Exception as e:
        log.warning("[generate-image] dominant color 추출 실패: %s", e)
        return None


# 고정 이미지 스타일 템플릿 — GPT 가 추출한 개체명만 끼워 넣는다.
# 변경 시 사용자에게 알리는 게 좋음 (그림 톤이 통째로 바뀜).
IMAGE_PROMPT_TEMPLATE = (
    "Simple 3D illustration of {subject}, cute and minimal, no text, no letters, "
    "smooth matte plastic texture, isolated subject on transparent background, "
    "no shadow ground plane, high quality, 3D render"
)


def _build_image_prompt(texts: List[str], kind: str, extra_hint: Optional[str]) -> str:
    """
    GPT-4o-mini 로 한국어 텍스트에서 핵심 개체명(영어 명사구) 만 뽑아
    고정 스타일 템플릿에 끼워 넣어 반환.
    실패 시 텍스트를 직접 사용한 fallback.
    """
    from openai import OpenAI

    joined = " / ".join(t.strip() for t in texts if t and t.strip())
    if not joined:
        joined = "프로모션 행사"

    extraction_instruction = (
        "다음 한국어 프로모션 문구의 핵심 시각적 주제(이미지의 메인 개체)를 "
        "영어 명사구 한 줄로만 답해줘.\n"
        "규칙:\n"
        "- 4단어 이내 (관사 'a/an' 포함 가능, 'the' 금지)\n"
        "- 명사구만, 문장이나 설명 금지\n"
        "- 텍스트·글자·로고·UI 요소는 절대 포함하지 말 것\n"
        "- 한국 모바일 카드/금융 앱 프로모션 톤. 사람 얼굴/실사 금지, 사물·아이콘적 개체 선호\n"
        "예시 답변: 'a stack of coupons', 'a piggy bank with cards', 'a gift box with confetti'\n\n"
        "프로모션 문구: " + joined
    )

    subject = ""
    try:
        client = OpenAI(api_key=CONFIG.openai_api_key)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You extract one short English noun phrase that captures the visual subject of Korean marketing copy. Reply with the noun phrase only."},
                {"role": "user", "content": extraction_instruction},
            ],
            temperature=0.5,
            max_tokens=30,
        )
        subject = (resp.choices[0].message.content or "").strip()
        # 따옴표·마침표·머리말 자동 제거
        subject = subject.strip().strip('"').strip("'").rstrip(".").strip()
        # 줄바꿈/콜론 잘라내기
        if "\n" in subject:
            subject = subject.split("\n", 1)[0].strip()
        if ":" in subject:
            subject = subject.split(":", 1)[-1].strip()
    except Exception as e:
        log.warning("[generate-image] 개체명 추출 실패 — fallback 사용: %s", e)

    if not subject:
        subject = "a promotional gift item"

    prompt = IMAGE_PROMPT_TEMPLATE.format(subject=subject)
    if extra_hint:
        prompt += ", " + extra_hint.strip()
    return prompt


# gpt-image-1 호출은 20초 이상 걸려서 Figma 플러그인 iframe의 fetch가
# 응답을 기다리다 중간에 끊긴다. 그래서 비동기 job 으로 분리해서
# POST /generate-image 는 즉시 job_id 만 돌려주고, plugin 은
# GET /generate-image/{job_id} 로 polling 한다.
_IMAGE_JOBS: Dict[str, dict] = {}
_IMAGE_JOBS_LOCK = threading.Lock()
_IMAGE_JOB_TTL_SEC = 600  # 완료/실패 후 보관 시간


def _gc_image_jobs() -> None:
    cutoff = time.time() - _IMAGE_JOB_TTL_SEC
    stale = [
        jid for jid, j in _IMAGE_JOBS.items()
        if j.get("finished_at") and j["finished_at"] < cutoff
    ]
    for jid in stale:
        _IMAGE_JOBS.pop(jid, None)


def _run_image_job(job_id: str, req: GenerateImageRequest) -> None:
    from openai import OpenAI

    try:
        size = _pick_gpt_image_size(req.width, req.height)
        log.info(
            "[generate-image:%s] 요청: kind=%s texts=%d (%dx%d → %s)",
            job_id, req.kind, len(req.texts), req.width, req.height, size,
        )
        with _IMAGE_JOBS_LOCK:
            _IMAGE_JOBS[job_id]["status"] = "running"
            _IMAGE_JOBS[job_id]["stage"] = "prompt"

        prompt = _build_image_prompt(req.texts, req.kind, req.extra_hint)
        log.info("[generate-image:%s] 프롬프트: %s", job_id, prompt[:200])
        with _IMAGE_JOBS_LOCK:
            _IMAGE_JOBS[job_id]["stage"] = "image"
            _IMAGE_JOBS[job_id]["prompt"] = prompt

        client = OpenAI(api_key=CONFIG.openai_api_key)
        # background="transparent" → 알파 채널 PNG 로 받음.
        # output_format="png" 명시 (transparent 는 png/webp 만 지원).
        result = client.images.generate(
            model="gpt-image-1", prompt=prompt, size=size, n=1,
            background="transparent", output_format="png",
        )
        if not result.data:
            raise RuntimeError("OpenAI 응답에 이미지 데이터가 없습니다.")
        b64 = getattr(result.data[0], "b64_json", None)
        if not b64:
            raise RuntimeError("OpenAI 응답에 b64_json 필드가 없습니다.")

        log.info("[generate-image:%s] 완료: %d bytes (base64)", job_id, len(b64))

        # dominant color (pastel L=87~93) 추출 — 프레임 배경색으로 사용
        try:
            png_bytes = base64.b64decode(b64, validate=True)
            bg_color = _extract_dominant_color_pastel(png_bytes)
        except Exception as e:
            log.warning("[generate-image:%s] dominant color 단계 실패: %s", job_id, e)
            bg_color = None
        log.info("[generate-image:%s] background_color=%s", job_id, bg_color)

        with _IMAGE_JOBS_LOCK:
            j = _IMAGE_JOBS[job_id]
            j["status"] = "completed"
            j["stage"] = "done"
            j["image_base64"] = b64
            j["size"] = size
            j["background_color"] = bg_color
            j["finished_at"] = time.time()
    except Exception as e:
        log.exception("[generate-image:%s] 실패", job_id)
        with _IMAGE_JOBS_LOCK:
            j = _IMAGE_JOBS.get(job_id)
            if j is not None:
                j["status"] = "failed"
                j["error"] = str(e)
                j["finished_at"] = time.time()


@app.post("/generate-image")
def generate_image(req: GenerateImageRequest):
    """
    팝업/배너 안에 들어갈 이미지를 gpt-image-1 으로 생성 (비동기 job).
    호출 즉시 job_id 를 돌려주고, 실제 처리는 백그라운드 thread 에서 진행.
    """
    if CONFIG is None or not CONFIG.openai_api_key:
        raise HTTPException(
            503,
            "openai_api_key 가 config 에 없습니다. "
            "~/.promo-export/config.json 에 \"openai_api_key\": \"sk-...\" 추가 후 Helper 재시작.",
        )

    job_id = uuid.uuid4().hex[:12]
    with _IMAGE_JOBS_LOCK:
        _gc_image_jobs()
        _IMAGE_JOBS[job_id] = {
            "status": "pending",
            "stage": "queued",
            "created_at": time.time(),
        }

    threading.Thread(target=_run_image_job, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id, "status": "pending"}


@app.get("/generate-image/{job_id}")
def generate_image_status(job_id: str):
    with _IMAGE_JOBS_LOCK:
        job = _IMAGE_JOBS.get(job_id)
        if not job:
            raise HTTPException(404, f"unknown job: {job_id}")
        out: dict = {
            "job_id": job_id,
            "status": job["status"],
            "stage": job.get("stage"),
        }
        if job.get("prompt"):
            out["prompt"] = job["prompt"]
        if job["status"] == "completed":
            out["image_base64"] = job.get("image_base64")
            out["size"] = job.get("size")
            out["background_color"] = job.get("background_color")
        elif job["status"] == "failed":
            out["error"] = job.get("error")
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7000, log_level="info")
