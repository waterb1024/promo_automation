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
# # 은 부가서비스 home-top 프레임명 끝의 _#RRGGBB 색상 접미사를 허용하기 위해 포함.
SAFE_FILENAME_RE = re.compile(
    r"^(?:[\w가-힣\-.# ]+/){0,2}[\w가-힣\-.# ]+\.(png|jpg|jpeg)$",
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
    addon: int = 0


class Metadata(BaseModel):
    date: str = Field(..., description="MMDD")
    promotion: str
    counts: Counts
    addon_positions: Optional[List[str]] = Field(
        default=None,
        description="부가서비스 프레임의 한글 위치 라벨 (예: '홈 상단', '생활편의 하단'). "
                    "순서는 선택 순서와 동일. counts.addon 개수와 동일한 length. "
                    "댓글 counts_text 를 위치별 breakdown 으로 렌더링할 때 사용.",
    )


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


class TransformIconRequest(BaseModel):
    image_base64: str = Field(..., description="원본 2D 아이콘 PNG (base64)")
    feedback: Optional[str] = Field(None, description="추가 스타일 코멘트 (선택)")


class GenerateImageRequest(BaseModel):
    texts: List[str] = Field(default_factory=list, description="팝업/배너의 텍스트들 (위→아래 순). 프롬프트 생성에 사용")
    width: int = Field(..., ge=64, le=4096, description="채울 사각형의 width (px)")
    height: int = Field(..., ge=64, le=4096, description="채울 사각형의 height (px)")
    kind: str = Field("popup", description="popup | banner | sotong — 톤·스타일 힌트")
    extra_hint: Optional[str] = Field(None, description="사용자가 직접 추가하는 스타일/제약 힌트 (선택)")
    style: str = Field("3d", description="3d | photoreal | illustration")
    emphasize_numbers: bool = Field(False, description="텍스트의 금액·퍼센트를 이미지에 강조 표시할지 (기본 off)")
    feedback: Optional[str] = Field(None, description="재생성 시 사용자가 입력한 피드백 — 무엇을 바꾸고 싶은지")
    subject: Optional[str] = Field(None, description="소통참여 등에서 사용자가 직접 지정한 이미지 주제. 값이 있으면 GPT 개체명 추출을 건너뛰고 그대로 사용.")
    prompt_template: Optional[str] = Field(None, description="주어지면 이 템플릿의 {subject} 자리에 subject/추출값을 끼워 최종 프롬프트로 사용. 없으면 style 기반 기본 템플릿 사용.")
    transparent_background: bool = Field(True, description="gpt-image-1 background='transparent' 여부. 실사 사진에는 False 권장.")


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


def _format_counts(counts, addon_positions: Optional[List[str]] = None) -> str:
    """
    counts 객체를 자연어 문자열로 조합. 0개인 타입은 제외.

    예) banner=1, popup=1, landing=1                → "배너1개, 팝업1개, 랜딩페이지1개"
    예) banner=0, popup=2, landing=1                → "팝업2개, 랜딩페이지1개"
    예) banner=2, popup=0, landing=0                → "배너2개"
    예) addon=3 (위치 없음)                          → "부가서비스3개"
    예) addon=1, positions=["홈 상단"]                → "홈 상단 배너1개"
    예) addon=2, positions=["홈 상단", "홈 상단"]     → "홈 상단 배너2개"
    예) addon=2, positions=["홈 상단", "생활편의 하단"] → "홈 상단 배너1개, 생활편의 하단 배너1개"
    예) 모두 0                                       → "시안"
    """
    parts = []
    if counts.banner > 0:
        parts.append(f"배너{counts.banner}개")
    if counts.popup > 0:
        parts.append(f"팝업{counts.popup}개")
    if counts.landing > 0:
        parts.append(f"랜딩페이지{counts.landing}개")
    if counts.addon > 0:
        if addon_positions:
            # 위치별 breakdown — 첫 등장 순서 유지 + 위치별 카운트 집계
            per_pos: Dict[str, int] = {}
            for label in addon_positions:
                per_pos[label] = per_pos.get(label, 0) + 1
            for label, n in per_pos.items():
                parts.append(f"{label} 배너{n}개")
        else:
            parts.append(f"부가서비스{counts.addon}개")
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
        "templates_sync_configured": bool(CONFIG and CONFIG.templates_sync_url),
    }


@app.get("/templates/fetch")
def templates_fetch():
    """
    config 의 templates_sync_url 에서 templates JSON 을 받아 그대로 반환.
    URL 예: GitHub raw — https://raw.githubusercontent.com/<org>/<repo>/<branch>/templates.json
    Private repo 면 templates_sync_token 으로 Authorization: Bearer 헤더 추가.
    """
    import urllib.error
    import urllib.request

    if CONFIG is None or not CONFIG.templates_sync_url:
        raise HTTPException(
            503,
            "templates_sync_url 이 config 에 없습니다. "
            "~/.promo-export/config.json 에 \"templates_sync_url\" 추가 후 helper 재시작.",
        )

    url = CONFIG.templates_sync_url
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    if CONFIG.templates_sync_token:
        req.add_header("Authorization", f"Bearer {CONFIG.templates_sync_token}")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise HTTPException(
            502,
            f"원격 templates fetch 실패: HTTP {e.code} ({url}). "
            "private repo 면 templates_sync_token 확인.",
        )
    except urllib.error.URLError as e:
        raise HTTPException(502, f"원격 templates fetch 실패: {e.reason} ({url})")

    try:
        config = json.loads(body)
    except json.JSONDecodeError as e:
        raise HTTPException(502, f"원격 templates JSON 파싱 실패: {e}")

    if not isinstance(config, dict) or config.get("version") != 1:
        raise HTTPException(502, "원격 templates 형식이 잘못됐습니다 (version=1 인 JSON 필요).")

    return {"ok": True, "config": config, "source_url": url}


def _is_single_image_mode(req) -> bool:
    """배너 또는 팝업이 1개뿐(랜딩 0, split 없음, 파일 1장)이면 zip 대신 이미지 직접 첨부."""
    counts = req.metadata.counts
    return (
        counts.landing == 0
        and (counts.banner + counts.popup) == 1
        and len(req.files) == 1
        and not req.splits
    )


def _decode_single_image(file: FileEntry) -> tuple[bytes, str]:
    """단일 이미지 base64 디코드 + 확장자 검증."""
    _safe_filename(file.filename)  # 형식 검증
    ext = file.filename.rsplit(".", 1)[-1].lower()
    if ext == "jpeg":
        ext = "jpg"
    if ext not in ("png", "jpg"):
        raise HTTPException(400, f"단일 이미지 확장자가 png/jpg 가 아닙니다: {file.filename}")
    try:
        data = base64.b64decode(file.base64, validate=True)
    except Exception as e:
        raise HTTPException(400, f"base64 디코드 실패: {file.filename} ({e})")
    return data, ext


@app.post("/package")
def package(req: PackageRequest):
    """zip(또는 단일 이미지) 생성만 — Way 호출 없음. dry-run / 검수용."""
    if not req.files:
        raise HTTPException(400, "파일이 비어 있습니다.")
    base = f"{req.metadata.date}_{req.metadata.promotion}"

    # 배너/팝업 1장만 있으면 zip 대신 png/jpg 그대로 저장
    if _is_single_image_mode(req):
        data, ext = _decode_single_image(req.files[0])
        out_path = OUTPUT_DIR / f"{base}.{ext}"
        if out_path.exists():
            ts = datetime.now().strftime("%H%M%S")
            out_path = OUTPUT_DIR / f"{base}_{ts}.{ext}"
        out_path.write_bytes(data)
        log.info("[package] 단일 이미지 저장 OK: %s (%d bytes)", out_path, len(data))
        return {
            "ok": True,
            "zip_path": str(out_path),
            "file_count": 1,
            "bytes": len(data),
            "single_image_mode": True,
        }

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
    """zip(또는 단일 이미지) 생성 → Way 이슈에 첨부 + 댓글 등록. 메인 워크플로우."""
    if not req.files:
        raise HTTPException(400, "파일이 비어 있습니다.")

    single_image_mode = _is_single_image_mode(req)

    jira = _get_jira_client()

    # 1) Way 이슈 조회 — reporter + 기존 첨부
    log.info("[upload] Way 이슈 조회: %s", req.jira_key)
    try:
        issue = jira.get_issue(req.jira_key)
    except JiraError as e:
        raise HTTPException(502, f"Way 이슈 조회 실패: {e}")
    existing_attachments = [a.filename for a in issue.attachments]

    if single_image_mode:
        # 배너/팝업 1장 → zip 없이 png/jpg 그대로 첨부
        data, ext = _decode_single_image(req.files[0])
        decision = decide_revision(
            req.metadata.date, req.metadata.promotion, existing_attachments,
            extension=ext,
        )
        attach_path = OUTPUT_DIR / decision.zip_filename
        attach_path.write_bytes(data)
        bytes_written = len(data)
        file_count = 1
        log.info(
            "[upload] 단일 이미지 모드: %s (%d bytes, revision=%s, index=%d, 기존 첨부=%d개)",
            decision.zip_filename, bytes_written,
            decision.is_revision, decision.revision_index,
            len(existing_attachments),
        )
    else:
        # 분할 spec 이 있으면 PIL crop 으로 PNG 추가
        expanded_files = _apply_splits(req.files, req.splits)
        if len(expanded_files) != len(req.files):
            log.info(
                "[upload] split 처리 결과: %d 파일 → %d 파일",
                len(req.files), len(expanded_files),
            )
        # landing 메인 + 자식 PNG 를 한 폴더로 묶기
        expanded_files = _organize_landing_folders(expanded_files)

        decision = decide_revision(
            req.metadata.date, req.metadata.promotion, existing_attachments,
        )
        attach_path = OUTPUT_DIR / decision.zip_filename
        log.info(
            "[upload] zip 파일명 결정: %s (revision=%s, index=%d, 기존 첨부=%d개)",
            decision.zip_filename, decision.is_revision, decision.revision_index,
            len(existing_attachments),
        )

        # zip 생성 (분할 처리된 expanded_files 사용)
        entries = _build_entries(expanded_files)
        bytes_written = write_utf8_zip(attach_path, entries)
        file_count = len(entries)
        log.info("[upload] zip 생성 OK: %s (%d bytes, %d files)",
                 attach_path, bytes_written, file_count)

    # Way 첨부
    log.info("[upload] Way 첨부 업로드 → %s", req.jira_key)
    try:
        jira.upload_attachment(req.jira_key, attach_path)
    except JiraError as e:
        raise HTTPException(502, f"Way 첨부 업로드 실패: {e}")

    # 5) 댓글 등록 (템플릿 + reporter 멘션)
    templates = json.loads(COMMENT_TEMPLATES_PATH.read_text(encoding="utf-8"))
    tpl_key = "revision" if decision.is_revision else "first_upload"
    if single_image_mode:
        # 단일 이미지면 다운로드 링크 대신 인라인 이미지로 렌더링되는 템플릿 사용
        tpl_key = f"{tpl_key}_image"
    tpl = templates[tpl_key]
    mention = (
        f"[~{issue.reporter_username}]" if issue.reporter_username else "@reporter"
    )
    counts_text = _format_counts(req.metadata.counts, req.metadata.addon_positions)
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

    log.info("[upload] 완료: issue=%s, attach=%s", req.jira_key, decision.zip_filename)
    return {
        "ok": True,
        "zip_path": str(attach_path),
        "zip_filename": decision.zip_filename,
        "is_revision": decision.is_revision,
        "revision_index": decision.revision_index,
        "file_count": file_count,
        "bytes": bytes_written,
        "issue_key": req.jira_key,
        "reporter_username": issue.reporter_username,
        "reporter_display": issue.reporter_display,
        "counts": req.metadata.counts.model_dump(),
        "comment": comment,
        "single_image_mode": single_image_mode,
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


def _derive_button_gradient_from_pastel(pastel_hex: Optional[str]) -> Optional[dict]:
    """
    Pastel dominant color 에서 버튼용 saturated 그라데이션 도출.
    Figma 참조 148:5583 (지금 주문하기·장바구니 채우러 가기·챌린지 구경하기)의
    (255,187,51→255,126,51 orange, 71,128,235→49,100,196 blue) 를 참고:
      - hue 를 시작→끝 사이 소폭 이동 (+12°) 해서 gradient 감 살림
      - L 은 0.50~0.42 로 완만한 어두워짐 (기존 0.45→0.37 은 너무 검게 빠져서 완화)
      - S 는 0.85~0.90 유지해서 흰 텍스트 대비 확보
    반환: {"start": "#RRGGBB", "end": "#RRGGBB"} 또는 None.
    """
    import colorsys
    if not pastel_hex:
        return None
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", pastel_hex.strip())
    if not m:
        return None
    hexstr = m.group(1)
    r = int(hexstr[0:2], 16) / 255.0
    g = int(hexstr[2:4], 16) / 255.0
    b = int(hexstr[4:6], 16) / 255.0
    h, _l, _s = colorsys.rgb_to_hls(r, g, b)
    # hue 는 [0, 1) 순환. +12° = +0.0333.
    h_end = (h + 12.0 / 360.0) % 1.0
    def _hex(hh: float, ss: float, ll: float) -> str:
        rr, gg, bb = colorsys.hls_to_rgb(hh, ll, ss)
        return "#{:02x}{:02x}{:02x}".format(
            int(round(rr * 255)), int(round(gg * 255)), int(round(bb * 255))
        )
    return {
        "start": _hex(h,     0.85, 0.50),
        "end":   _hex(h_end, 0.90, 0.42),
    }


def _derive_button_from_pastel(pastel_hex: Optional[str],
                               l_target: float = 0.50,
                               s_min: float = 0.55) -> Optional[str]:
    """
    Pastel 배경색(_extract_dominant_color_pastel 결과)의 hue 를 유지하고
    Lightness=l_target 로 낮춰서 버튼용 saturated hex 로 변환.
    Saturation 이 s_min 미만이면 s_min 으로 끌어올린다 (파스텔이 지나치게
    희미하면 버튼도 회색 톤이 되어버려서).
    """
    import colorsys
    if not pastel_hex:
        return None
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", pastel_hex.strip())
    if not m:
        return None
    hexstr = m.group(1)
    r = int(hexstr[0:2], 16) / 255.0
    g = int(hexstr[2:4], 16) / 255.0
    b = int(hexstr[4:6], 16) / 255.0
    h, _l, s = colorsys.rgb_to_hls(r, g, b)
    s2 = max(s_min, s)
    l2 = max(0.0, min(1.0, l_target))
    r2, g2, b2 = colorsys.hls_to_rgb(h, l2, s2)
    return "#{:02x}{:02x}{:02x}".format(
        int(round(r2 * 255)), int(round(g2 * 255)), int(round(b2 * 255))
    )


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


# 스타일별 이미지 프롬프트 템플릿 — GPT 가 추출한 개체명만 끼워 넣는다.
# UI 드롭다운의 value 와 키가 일치해야 함 (3d / photoreal / illustration).
IMAGE_PROMPT_TEMPLATES = {
    "3d": (
        "Simple 3D illustration of {subject}, cute and minimal, no text, no letters, "
        "smooth matte plastic texture, isolated subject on transparent background, "
        "no shadow ground plane, high quality, 3D render"
    ),
    # 부가서비스 [홈 중단] 전용 — 아이콘 그리드용 flat 벡터.
    # "no text, no letters" 를 앞쪽에 두어 gpt-image-1 이 텍스트를 그리지 않도록.
    "2d-flat-solid": (
        "Flat design illustration of {subject}, no text, no letters, "
        "solid color fills only, no outline, no stroke, no line art, "
        "simple clean vector style"
    ),
    "photoreal": (
        "Photorealistic studio photograph of {subject}, soft natural lighting, "
        "isolated subject on transparent background, no text, no letters, no logo, "
        "no shadow ground plane, sharp focus, high resolution, professional product photography"
    ),
    "illustration": (
        "Flat design illustration of {subject}, simple clean vector style, "
        "solid color fills only, no outline, no stroke, no line art, "
        "no text, no letters"
    ),
}
DEFAULT_IMAGE_STYLE = "3d"


# 텍스트에서 명시적 금액·퍼센트 추출 — 이미지에 prominent 하게 노출할 후보.
# 이미지에 들어갈 형태로 정규화:
#   "5만원"     → "50000"   (만원 펼침 + 원/콤마 제거)
#   "20,000원"  → "20000"   (콤마/원 제거)
#   "30000원"   → "30000"
#   "5%"        → "5%"      (% 유지)
_PRICE_RE = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)\s*원")
_WAN_RE = re.compile(r"(\d+)\s*만\s*원")
_PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")


# 한국 지역명 + 영문 음역. 동음이의 일반명사가 있는 케이스는 "NOT ..." 부연으로
# GPT-4o-mini 가 도시명을 일반 명사(예: 양산=parasol, 경주=race)로 오역하지 않게 차단.
KOREAN_PLACE_NAMES = {
    # 1차 등록
    "밀양": "Miryang city in South Korea",
    "진천": "Jincheon county in South Korea",
    "충주": "Chungju city in South Korea",
    "상주": "Sangju city in South Korea (NOT the Korean word meaning 'permanent residence')",
    "세종": "Sejong city in South Korea",
    "천안": "Cheonan city in South Korea",
    "강릉": "Gangneung city in South Korea",
    "경주": "Gyeongju city in South Korea (NOT the Korean word for 'race/competition')",
    "김포": "Gimpo city in South Korea",
    "청주": "Cheongju city in South Korea",
    "영암": "Yeongam county in South Korea",
    "경기": "Gyeonggi province in South Korea (NOT the Korean word for 'game/match')",
    "양산": "Yangsan city in South Korea (NOT the Korean word for 'parasol/umbrella')",
    "인천": "Incheon city in South Korea",
    # 2차 등록
    "영광": "Yeonggwang county in South Korea (NOT the Korean word for 'glory')",
    "경산": "Gyeongsan city in South Korea",
    "고성": "Goseong county in South Korea (NOT the Korean word for 'loud voice')",
    "영월": "Yeongwol county in South Korea",
    "김천": "Gimcheon city in South Korea",
    "동해": "Donghae coastal city in South Korea (NOT the literal 'East Sea')",
    "의성": "Uiseong county in South Korea",
    "옥천": "Okcheon county in South Korea",
    "삼척": "Samcheok city in South Korea",
    "음성": "Eumseong county in South Korea (NOT the Korean word for 'voice/sound')",
    "인제": "Inje county in South Korea",
    "횡성": "Hoengseong county in South Korea",
    "태백": "Taebaek city in South Korea",
    "울진": "Uljin county in South Korea",
}


def _annotate_korean_places(text: str) -> str:
    """텍스트에 한국 지역명이 있으면 음역+부연 힌트를 1회 덧붙인다."""
    if not text:
        return text
    for name, annotation in KOREAN_PLACE_NAMES.items():
        if name in text:
            text = text.replace(name, f"{name} ({annotation})", 1)
    return text


def _extract_highlight_numbers(texts: List[str]) -> List[str]:
    out: List[str] = []
    seen = set()
    def _add(v: str) -> None:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    for t in texts:
        if not t:
            continue
        # "5만원" 먼저 처리 → 숫자만 ("50000")
        for m in _WAN_RE.finditer(t):
            try:
                n = int(m.group(1))
                _add(str(n * 10000))
            except ValueError:
                pass
        # 일반 금액 — "5만원" 매치 이후 남은 패턴. 콤마/원 제거하고 숫자만
        stripped = _WAN_RE.sub("", t)
        for m in _PRICE_RE.finditer(stripped):
            raw = m.group(1).replace(",", "")
            _add(raw)
        # 퍼센트는 그대로
        for m in _PCT_RE.finditer(t):
            _add(f"{m.group(1)}%")
    return out


def _sanitize_subject_for_no_text(subject: str) -> str:
    """
    소통참여 등 '실사 사진 + 텍스트 금지' 프롬프트에서 주제 정제.

    괄호는 보통 '이름(설명)' 패턴으로 쓰여서 시각적으로 의미가 있는 건 괄호 안.
    → 괄호 안 설명을 살리고 앞 이름은 버린다.

    예:
      '드림나래(면접정장대여)' → '면접정장대여'
      '카페(따뜻한 실내)'     → '따뜻한 실내'
      '아이스크림'              → '아이스크림' (괄호 없으면 그대로)

    여러 개의 괄호가 있으면 마지막 괄호 안 내용을 사용.
    괄호 안이 비어 있으면 앞부분을 fallback 으로 유지.
    """
    if not subject:
        return subject
    s = subject
    # 마지막 괄호 안 내용 추출 (전각/반각 모두)
    matches = re.findall(r"[\(（]([^\)）]*)[\)）]", s)
    inner = None
    for m in reversed(matches):
        stripped = m.strip()
        if stripped:
            inner = stripped
            break
    if inner:
        s = inner
    else:
        # 괄호가 없거나 안이 비어있음 → 대괄호 제거만 하고 원본 사용
        s = re.sub(r"\s*[\(（][^\)）]*[\)）]\s*", " ", s)
    # 대괄호는 부수적 메타 정보라고 보고 제거
    s = re.sub(r"\s*\[[^\]]*\]\s*", " ", s)
    # 언더스코어/연속 공백 정리
    s = re.sub(r"[_\s]+", " ", s).strip()
    return s or subject


def _build_image_prompt(texts: List[str], kind: str,
                        extra_hint: Optional[str], style: str = DEFAULT_IMAGE_STYLE,
                        emphasize_numbers: bool = False,
                        feedback: Optional[str] = None,
                        subject_override: Optional[str] = None,
                        prompt_template: Optional[str] = None) -> str:
    """
    GPT-4o-mini 로 한국어 텍스트에서 핵심 개체명(영어 명사구) 만 뽑아
    고정 스타일 템플릿에 끼워 넣어 반환.
    실패 시 텍스트를 직접 사용한 fallback.

    subject_override 가 주어지면 GPT 추출을 건너뛰고 그대로 사용.
    prompt_template 가 주어지면 style 기반 기본 템플릿 대신 이 템플릿의
      {subject} 자리에 subject 를 끼워 최종 프롬프트를 만든다.
    """
    from openai import OpenAI

    # subject 직접 지정 경로 (소통참여 등)
    if subject_override and subject_override.strip():
        subject = _sanitize_subject_for_no_text(subject_override.strip())
        template = prompt_template or (
            IMAGE_PROMPT_TEMPLATES.get(style) or IMAGE_PROMPT_TEMPLATES[DEFAULT_IMAGE_STYLE]
        )
        prompt = template.format(subject=subject)
        if extra_hint:
            prompt += ", " + extra_hint.strip()
        if feedback:
            prompt += ", user refinement request: " + feedback.strip()
        # 최종 안전장치: 프롬프트 맨 끝에도 텍스트 금지 재선언
        prompt += (
            " REMINDER: zero text, zero letters, zero characters, "
            "zero signage, zero writing of any kind — this is critical."
        )
        return prompt

    joined = " / ".join(_annotate_korean_places(t.strip()) for t in texts if t and t.strip())
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
    if feedback:
        # 사용자가 직전 결과를 보고 입력한 피드백 — 다음 추출에 반영
        extraction_instruction += (
            "\n\n사용자 피드백 (직전 이미지가 마음에 안 들었던 점 / 바꾸고 싶은 점): "
            + feedback.strip()
            + "\n이 피드백을 적극 반영해서 새로운 개체명을 골라줘."
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

    template = IMAGE_PROMPT_TEMPLATES.get(style) or IMAGE_PROMPT_TEMPLATES[DEFAULT_IMAGE_STYLE]
    prompt = template.format(subject=subject)

    # 옵트인 "숫자 강조": emphasize_numbers=True 일 때만 금액/% 를 이미지에 노출.
    # 추출된 값은 이미 "원" 단위 제거 + 콤마 제거된 형태 (예: "20000", "5%")
    if emphasize_numbers:
        highlights = _extract_highlight_numbers(texts)
        if highlights:
            primary_display = highlights[0]
            # "no text, no letters" / "no text" / "no letters" 제거
            prompt = re.sub(r",\s*no text,\s*no letters", "", prompt)
            prompt = re.sub(r",\s*no text", "", prompt)
            prompt = re.sub(r",\s*no letters", "", prompt)
            prompt += (
                f', the giant oversized number "{primary_display}" '
                "rendered in extremely bold thick typography is the dominant element "
                "occupying most of the canvas, drawn substantially larger than any other "
                "illustration element, as the central focal point; all other elements are "
                "significantly smaller and act as supporting decoration; "
                "no other text or letters anywhere"
            )

    if extra_hint:
        prompt += ", " + extra_hint.strip()
    if feedback:
        # gpt-image-1 에도 사용자 피드백을 직접 전달 — 추출 단계와 이미지 단계 모두 반영
        prompt += ", user refinement request: " + feedback.strip()
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

        prompt = _build_image_prompt(
            req.texts, req.kind, req.extra_hint, req.style,
            req.emphasize_numbers, req.feedback,
            subject_override=req.subject,
            prompt_template=req.prompt_template,
        )
        log.info("[generate-image:%s] 프롬프트: %s", job_id, prompt[:200])
        with _IMAGE_JOBS_LOCK:
            _IMAGE_JOBS[job_id]["stage"] = "image"
            _IMAGE_JOBS[job_id]["prompt"] = prompt

        client = OpenAI(api_key=CONFIG.openai_api_key)
        # transparent 요청 시에만 background='transparent' + png 명시.
        # 실사 사진(소통참여 등) 은 opaque 로 받는다.
        gen_kwargs = dict(
            model="gpt-image-1", prompt=prompt, size=size, n=1,
            output_format="png",
        )
        if req.transparent_background:
            gen_kwargs["background"] = "transparent"
        result = client.images.generate(**gen_kwargs)
        if not result.data:
            raise RuntimeError("OpenAI 응답에 이미지 데이터가 없습니다.")
        b64 = getattr(result.data[0], "b64_json", None)
        if not b64:
            raise RuntimeError("OpenAI 응답에 b64_json 필드가 없습니다.")

        log.info("[generate-image:%s] 완료: %d bytes (base64)", job_id, len(b64))

        # dominant color (pastel L=87~93) 추출 — 프레임 배경색으로 사용
        # + 같은 hue 의 saturated variant (L=0.50) 를 버튼색으로 파생
        try:
            png_bytes = base64.b64decode(b64, validate=True)
            bg_color = _extract_dominant_color_pastel(png_bytes)
        except Exception as e:
            log.warning("[generate-image:%s] dominant color 단계 실패: %s", job_id, e)
            bg_color = None
        button_color = _derive_button_from_pastel(bg_color) if bg_color else None
        button_gradient = _derive_button_gradient_from_pastel(bg_color) if bg_color else None
        log.info("[generate-image:%s] background_color=%s button_color=%s button_gradient=%s",
                 job_id, bg_color, button_color, button_gradient)

        with _IMAGE_JOBS_LOCK:
            j = _IMAGE_JOBS[job_id]
            j["status"] = "completed"
            j["stage"] = "done"
            j["image_base64"] = b64
            j["size"] = size
            j["background_color"] = bg_color
            j["button_color"] = button_color
            j["button_gradient"] = button_gradient
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


# ─────────── 아이콘 3D 변환 ───────────
# 부가서비스 "아이콘" position 전용:
# 사용자가 Figma 에서 선택한 프레임을 PNG 로 export → gpt-image-1 images.edit
# 으로 3D 렌더 스타일로 재변환 → 같은 프레임에 다시 fill.
# 프롬프트는 고정 (사용자 요청 문구 그대로) + feedback 만 append.
ICON_3D_PROMPT = "smooth matte plastic texture, cute and minimal, 3D render"


def _run_icon_transform_job(job_id: str, req: TransformIconRequest) -> None:
    from openai import OpenAI

    try:
        prompt = ICON_3D_PROMPT
        if req.feedback and req.feedback.strip():
            prompt += ", user refinement request: " + req.feedback.strip()
        log.info("[transform-icon:%s] 요청 (프롬프트 len=%d)", job_id, len(prompt))
        with _IMAGE_JOBS_LOCK:
            _IMAGE_JOBS[job_id]["status"] = "running"
            _IMAGE_JOBS[job_id]["stage"] = "image_edit"
            _IMAGE_JOBS[job_id]["prompt"] = prompt

        try:
            png_in = base64.b64decode(req.image_base64, validate=True)
        except Exception as e:
            raise RuntimeError(f"입력 image_base64 디코딩 실패: {e}")

        client = OpenAI(api_key=CONFIG.openai_api_key)
        # images.edit — 입력 이미지의 실루엣·주제를 유지하며 스타일만 변환
        result = client.images.edit(
            model="gpt-image-1",
            image=("icon.png", png_in, "image/png"),
            prompt=prompt,
            size="1024x1024",
            n=1,
            background="transparent",
        )
        if not result.data:
            raise RuntimeError("OpenAI 응답에 이미지 데이터가 없습니다.")
        b64_out = getattr(result.data[0], "b64_json", None)
        if not b64_out:
            raise RuntimeError("OpenAI 응답에 b64_json 필드가 없습니다.")

        log.info("[transform-icon:%s] 완료: %d bytes", job_id, len(b64_out))
        with _IMAGE_JOBS_LOCK:
            j = _IMAGE_JOBS[job_id]
            j["status"] = "completed"
            j["stage"] = "done"
            j["image_base64"] = b64_out
            j["size"] = "1024x1024"
            # 아이콘은 색상 추출·버튼색 사용 안함
            j["background_color"] = None
            j["button_color"] = None
            j["finished_at"] = time.time()
    except Exception as e:
        log.exception("[transform-icon:%s] 실패", job_id)
        with _IMAGE_JOBS_LOCK:
            j = _IMAGE_JOBS.get(job_id)
            if j is not None:
                j["status"] = "failed"
                j["error"] = str(e)
                j["finished_at"] = time.time()


@app.post("/transform-icon")
def transform_icon(req: TransformIconRequest):
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
    threading.Thread(target=_run_icon_transform_job, args=(job_id, req), daemon=True).start()
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
            out["button_color"] = job.get("button_color")
            out["button_gradient"] = job.get("button_gradient")
        elif job["status"] == "failed":
            out["error"] = job.get("error")
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7000, log_level="info")
