#!/usr/bin/env sh
# UGCS 차량 탑재 서버 기동 (Linux/macOS) - 인터넷 불필요
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python)
[ -z "$PY" ] && { echo "[UGCS] Python 3.10 이상이 필요합니다."; exit 1; }
exec "$PY" run.py "$@"
