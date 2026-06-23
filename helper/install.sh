#!/usr/bin/env bash
#
# Promotion Automation Helper - macOS 설치 스크립트 (v3.7)
#
# - 코드는 disk 위치 (이 install.sh 가 있는 디렉토리) 직접 사용
#   → 코드 수정 후 helper 재시작만 하면 자동 적용 (복사 안 함)
# - venv + 로그만 ~/.promo-automation 에 (Documents 백업 부담 줄이려고)
# - launchd로 로그인 시 자동 실행 등록
# - 127.0.0.1:7000 헬스체크로 마무리
#
# 사용법:
#   cd helper && bash install.sh
#
set -euo pipefail

# 코드 위치 — 이 install.sh 가 있는 디렉토리 = helper 디렉토리
# -P 옵션으로 symlink resolve → 항상 physical path
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd -P )"

# venv + 로그 위치 — hidden 폴더 (코드와 분리 가능)
INSTALL_DIR="$HOME/.promo-automation"
PLIST_LABEL="com.konai.promo-automation"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PORT=7000

# === macOS TCC 자동 감지 ===
# launchd 는 ~/Documents, ~/Desktop, ~/Downloads 안의 파일을 못 읽음 (Operation not permitted).
# SCRIPT_DIR 가 그런 보호 폴더면 → ~/.promo-automation/helper-src 로 자동 이동 옵션 제공.
HELPER_SRC_DIR="$INSTALL_DIR/helper-src"
case "$SCRIPT_DIR" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*)
    echo "[!] 경고: helper 코드 위치가 macOS TCC 보호 폴더 안입니다."
    echo "    현재: $SCRIPT_DIR"
    echo "    이 위치는 launchd 가 접근 못 해서 helper 가 동작하지 않습니다."
    echo ""
    echo "    해결: ~/.promo-automation/helper-src 로 옮기고,"
    echo "          현재 위치에는 그쪽 가리키는 symlink 를 만듭니다."
    echo "          (Finder / Editor 에서 보고 편집하는 방식은 동일)"
    echo ""
    read -r -p "    자동으로 이동하시겠어요? [y/N] " auto_move
    if [[ "$auto_move" =~ ^[Yy]$ ]]; then
      if [ -e "$HELPER_SRC_DIR" ] && [ ! -L "$HELPER_SRC_DIR" ]; then
        echo "    [!] $HELPER_SRC_DIR 가 이미 존재합니다. 중단."
        echo "        백업 후 수동 처리: mv $HELPER_SRC_DIR ${HELPER_SRC_DIR}.bak"
        exit 1
      fi
      echo "    → 이동 중..."
      mv "$SCRIPT_DIR" "$HELPER_SRC_DIR"
      ln -s "$HELPER_SRC_DIR" "$SCRIPT_DIR"
      echo "    ✓ 코드 위치 → $HELPER_SRC_DIR"
      echo "    ✓ symlink: $SCRIPT_DIR → $HELPER_SRC_DIR"
      SCRIPT_DIR="$HELPER_SRC_DIR"
    else
      echo "    중단. 수동으로 ~/Documents 밖 위치로 옮긴 뒤 다시 실행하세요."
      exit 1
    fi
    ;;
esac

echo "==> Promotion Automation Helper 설치 (v3.7)"
echo "    코드 위치 (수정 시 자동 적용): $SCRIPT_DIR"
echo "    venv + 로그 위치:              $INSTALL_DIR"
echo "    포트:                          $PORT"
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "[!] python3가 필요합니다. 설치 후 다시 실행하세요."
  echo "    예) brew install python@3.11"
  exit 1
fi
PY_VER=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "==> python3 버전: $PY_VER"

mkdir -p "$INSTALL_DIR"

# 옛 install 의 잔재 정리 — 코드 파일이 hidden 폴더에 있으면 제거 (venv/로그는 유지)
# 이렇게 안 하면 disk 와 hidden 폴더 코드가 동시에 존재해서 헷갈림.
if [ -f "$INSTALL_DIR/main.py" ]; then
  echo "==> 옛 install 의 hidden 폴더 코드 파일 정리"
  rm -f "$INSTALL_DIR/main.py"
  rm -f "$INSTALL_DIR/requirements.txt"
  rm -f "$INSTALL_DIR/comment_templates.json"
  rm -rf "$INSTALL_DIR/scripts"
fi

# legacy config 자동 마이그레이션:
#   ~/Documents/.promo-export/config.json  →  ~/.promo-export/config.json
# macOS TCC 가 ~/Documents 를 보호 폴더로 분류해서 launchd 가 못 읽음.
LEGACY_CFG_DIR="$HOME/Documents/.promo-export"
LEGACY_CFG="$LEGACY_CFG_DIR/config.json"
NEW_CFG_DIR="$HOME/.promo-export"
NEW_CFG="$NEW_CFG_DIR/config.json"

if [ -f "$LEGACY_CFG" ] && [ ! -f "$NEW_CFG" ]; then
  echo "==> config 를 launchd 접근 가능한 위치로 이동: $NEW_CFG"
  mkdir -p "$NEW_CFG_DIR"
  chmod 700 "$NEW_CFG_DIR"
  cp "$LEGACY_CFG" "$NEW_CFG"
  chmod 600 "$NEW_CFG"
  echo "    (legacy 파일은 $LEGACY_CFG 에 남겨두었습니다. 정상 동작 확인 후 직접 삭제 가능)"
elif [ -f "$NEW_CFG" ]; then
  echo "==> config 이미 새 위치에 있음: $NEW_CFG"
else
  echo "[!] config 가 ~/.promo-export/config.json 또는 ~/Documents/.promo-export/config.json 어디에도 없습니다."
  echo "    Helper 는 기동되지만 /package_and_upload 호출은 503 으로 응답합니다."
fi

# 출력 폴더 — launchd 가 접근 가능한 위치 미리 준비
mkdir -p "$INSTALL_DIR/output"

if [ ! -d "$INSTALL_DIR/venv" ]; then
  echo "==> 가상환경 생성"
  python3 -m venv "$INSTALL_DIR/venv"
fi
echo "==> 의존성 설치 (disk 의 requirements.txt 사용)"
"$INSTALL_DIR/venv/bin/pip" install --upgrade pip >/dev/null
"$INSTALL_DIR/venv/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"

echo "==> launchd 등록 (코드는 disk 위치 직접 사용)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${INSTALL_DIR}/venv/bin/python</string>
    <string>${SCRIPT_DIR}/main.py</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${SCRIPT_DIR}</string>

  <key>StandardOutPath</key>
  <string>${INSTALL_DIR}/helper.log</string>

  <key>StandardErrorPath</key>
  <string>${INSTALL_DIR}/helper.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo "==> Helper 기동 대기..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo
    echo "✓ 설치 완료. Helper가 http://127.0.0.1:${PORT} 에서 실행 중입니다."
    echo "  코드 위치: $SCRIPT_DIR (수정 후 재시작만 하면 자동 반영)"
    echo "  로그:      $INSTALL_DIR/helper.log"
    echo "  중지:      launchctl unload $PLIST_PATH"
    echo "  재시작:    launchctl unload $PLIST_PATH && launchctl load $PLIST_PATH"
    exit 0
  fi
  sleep 1
done

echo
echo "[!] Helper가 ${PORT} 포트에서 응답하지 않습니다."
echo "    로그를 확인하세요: $INSTALL_DIR/helper.err.log"
exit 1
