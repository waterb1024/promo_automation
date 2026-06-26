"""
설정 로더.

위치: ~/Documents/.promo-export/config.json   (mode 600 권장)

필수:
  way_base_url
  way_pat 또는 (way_username + way_password)

선택:
  output_dir         — 기본 ~/Desktop/PromoAutomation
  default_file_key   — Figma MCP 호출 시 기본 fileKey (없으면 더미값 사용)
  openai_api_key     — 팝업/배너 이미지 AI 생성용 (gpt-image-1). 없으면 /generate-image 503

예시:
{
  "way_base_url":  "https://konaway.konai.com",
  "way_username":  "sb.shin14",
  "way_password":  "...",
  "output_dir":    "~/Desktop/PromoAutomation",
  "default_file_key": "4inuJPmyGI1LfsuAiS5bts",
  "openai_api_key": "sk-..."
}

* figma_token 은 더 이상 필요 없음 — Figma MCP 가 인증을 처리한다.
"""
from __future__ import annotations

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

def _detect_documents_dir() -> Path:
    """
    macOS 호스트와 Cowork 샌드박스 양쪽에서 ~/Documents 위치를 찾는다.
    우선순위:
      1. PROMO_EXPORT_DOCS_DIR 환경변수
      2. ~/Documents (호스트)
      3. /sessions/*/mnt/Documents (Cowork 샌드박스)
    """
    import os as _os
    env = _os.environ.get("PROMO_EXPORT_DOCS_DIR")
    if env:
        return Path(env)
    home_doc = Path.home() / "Documents"
    if home_doc.exists():
        return home_doc
    sessions_root = Path("/sessions")
    if sessions_root.exists():
        try:
            for d in sessions_root.iterdir():
                try:
                    cand = d / "mnt" / "Documents"
                    if cand.exists():
                        return cand
                except (PermissionError, OSError):
                    continue
        except (PermissionError, OSError):
            pass
    return home_doc  # 못 찾으면 host 기본 경로 반환 — 에러 메시지에 그대로 나옴


DOCUMENTS_DIR = _detect_documents_dir()


def _detect_config_dir() -> Path:
    """
    config 위치 우선순위:
      1. PROMO_EXPORT_CONFIG_DIR 환경변수
      2. ~/.promo-export                    (TCC 보호 외 — launchd 접근 가능)
      3. ~/Documents/.promo-export          (legacy — launchd 에서는 PermissionError)
    """
    env = os.environ.get("PROMO_EXPORT_CONFIG_DIR")
    if env:
        return Path(env)
    primary = Path.home() / ".promo-export"
    if primary.exists():
        return primary
    legacy = DOCUMENTS_DIR / ".promo-export"
    if legacy.exists():
        return legacy
    return primary  # 신규 default


CONFIG_DIR = _detect_config_dir()
CONFIG_PATH = CONFIG_DIR / "config.json"


def _load_dotenv() -> None:
    """
    helper 디렉토리 옆 .env 가 있으면 os.environ 에 주입 (이미 있는 값은 보존).
    KEY=value 한 줄 형식만 지원. 따옴표 자동 제거.
    """
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except (OSError, UnicodeDecodeError):
        pass


_load_dotenv()

# 기본 출력 위치 — Desktop/Documents 는 TCC 보호되어 launchd 가 못 씀.
# helper install dir(~/.promo-automation) 하위 폴더가 launchd 도 접근 가능한 안전한 위치.
DEFAULT_OUTPUT = Path.home() / ".promo-automation" / "output"


@dataclass
class Config:
    way_base_url: str
    output_dir: Path
    way_pat: Optional[str] = None
    way_username: Optional[str] = None
    way_password: Optional[str] = None
    default_file_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    templates_sync_url: Optional[str] = None
    templates_sync_token: Optional[str] = None

    @property
    def way_api_base(self) -> str:
        return self.way_base_url.rstrip("/") + "/rest/api/2"

    @property
    def way_session_url(self) -> str:
        return self.way_base_url.rstrip("/") + "/rest/auth/1/session"


class ConfigError(RuntimeError):
    pass


def load_config(path: Optional[Path] = None) -> Config:
    p = Path(path) if path else CONFIG_PATH
    if not p.exists():
        raise ConfigError(
            f"설정 파일이 없습니다: {p}\n"
            f"SKILL.md 의 '설치' 섹션을 참고해서 config.json 을 먼저 만들어주세요."
        )

    _check_file_perms(p)

    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"설정 파일 JSON 파싱 실패: {p} — {e}")

    way_base_url = (raw.get("way_base_url") or "").rstrip("/")
    way_pat = (raw.get("way_pat") or "").strip() or None
    way_username = (raw.get("way_username") or "").strip() or None
    way_password = raw.get("way_password") or None
    default_file_key = (raw.get("default_file_key") or "").strip() or None
    openai_api_key = (raw.get("openai_api_key") or "").strip() or None
    if not openai_api_key:
        # .env 또는 OS 환경변수 OPENAI_API_KEY 로 fallback
        env_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if env_key:
            openai_api_key = env_key

    templates_sync_url = (raw.get("templates_sync_url") or "").strip() or None
    templates_sync_token = (raw.get("templates_sync_token") or "").strip() or None
    if not templates_sync_token:
        env_token = os.environ.get("TEMPLATES_SYNC_TOKEN", "").strip()
        if env_token:
            templates_sync_token = env_token

    missing = []
    if not way_base_url:
        missing.append("way_base_url")
    if not way_pat and not (way_username and way_password):
        missing.append("way_pat 또는 (way_username + way_password)")
    if missing:
        raise ConfigError(f"설정 파일에 필수 항목 누락: {missing}")

    output_dir_raw = raw.get("output_dir") or str(DEFAULT_OUTPUT)
    output_dir = Path(os.path.expanduser(output_dir_raw))

    in_sandbox = str(DOCUMENTS_DIR).startswith("/sessions/")
    # 샌드박스에서는 mount 된 ~/Documents 밖의 경로(예: ~/Desktop)는 호스트와 동기화 안 됨
    if in_sandbox and not str(output_dir).startswith(str(DOCUMENTS_DIR.parent)):
        import sys
        print(
            f"[경고] 샌드박스 환경: output_dir '{output_dir}' 은 호스트와 동기화되지 않습니다. "
            f"기본 위치로 폴백: {DEFAULT_OUTPUT}",
            file=sys.stderr,
        )
        output_dir = DEFAULT_OUTPUT

    # mkdir + 실제 쓰기 가능한지 확인 (macOS TCC 가 mkdir 은 통과시키지만 file open 은 차단)
    output_dir = _ensure_writable(output_dir, DEFAULT_OUTPUT)
    return _build_config(
        way_base_url, output_dir, way_pat, way_username, way_password,
        default_file_key, openai_api_key,
        templates_sync_url, templates_sync_token,
    )


def _ensure_writable(target: Path, fallback: Path) -> Path:
    """target 에 실제로 쓸 수 있는지 확인. 안 되면 fallback 으로 떨어뜨림."""
    import sys

    def _try(path: Path) -> bool:
        try:
            path.mkdir(parents=True, exist_ok=True)
            test = path / ".write_test"
            test.write_text("ok", encoding="utf-8")
            test.unlink()
            return True
        except (OSError, PermissionError):
            return False

    if _try(target):
        return target

    print(
        f"[경고] output_dir '{target}' 에 쓸 수 없습니다 (TCC 보호 가능성). "
        f"기본 위치로 폴백: {fallback}",
        file=sys.stderr,
    )
    if _try(fallback):
        return fallback
    raise ConfigError(f"output_dir 도, 기본 위치 {fallback} 도 쓸 수 없습니다.")


def _build_config(way_base_url, output_dir, way_pat, way_username, way_password,
                  default_file_key, openai_api_key=None,
                  templates_sync_url=None, templates_sync_token=None):
    return Config(
        way_base_url=way_base_url,
        output_dir=output_dir,
        way_pat=way_pat,
        way_username=way_username,
        way_password=way_password,
        default_file_key=default_file_key,
        openai_api_key=openai_api_key,
        templates_sync_url=templates_sync_url,
        templates_sync_token=templates_sync_token,
    )


def _check_file_perms(p: Path) -> None:
    try:
        mode = p.stat().st_mode & 0o777
    except OSError:
        return
    if mode & (stat.S_IRGRP | stat.S_IROTH | stat.S_IWGRP | stat.S_IWOTH):
        import sys
        print(
            f"[경고] config 파일 권한이 너무 열려있습니다 (mode={oct(mode)}). "
            f"다음 명령으로 잠가주세요:\n  chmod 600 \"{p}\"",
            file=sys.stderr,
        )
