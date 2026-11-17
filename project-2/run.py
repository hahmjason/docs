#!/usr/bin/env python3
"""UGCS 차량 탑재 서버 기동 스크립트 (인터넷 불필요, 표준 라이브러리만 사용).

    python run.py                       # 0.0.0.0:8080, data/ugcs.sqlite3
    python run.py --port 9000 --db D:/ugcs.db
    python run.py --reset               # DB 초기화 후 기동 (기존 기록 삭제)
"""
from __future__ import annotations

import argparse
import os
import signal
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ugcs import __version__, config  # noqa: E402
from ugcs.server.app import create_app  # noqa: E402


def lan_addresses() -> list[str]:
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):        # Windows 콘솔(cp949)에서도 한글 출력 안전
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="UGCS 무인기 지상통제 서버")
    ap.add_argument("--host", default=config.HOST)
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--db", default=str(config.DB_PATH))
    ap.add_argument("--reset", action="store_true", help="DB 파일을 지우고 시드 데이터로 다시 시작")
    a = ap.parse_args(argv)

    if a.reset:
        for suffix in ("", "-wal", "-shm"):
            p = Path(a.db + suffix)
            if p.exists():
                p.unlink()

    httpd, svc = create_app(a.db, a.host, a.port)
    print(f"UGCS v{__version__} — 차량 탑재 지상통제 서버")
    print(f"  DB      : {Path(a.db).resolve()}")
    print(f"  콘솔    : http://127.0.0.1:{a.port}/")
    for ip in lan_addresses():
        print(f"  차량 LAN: http://{ip}:{a.port}/")
    print(f"  헬스체크: http://127.0.0.1:{a.port}/health")
    print("  기본 계정: pilot1/1111 · mc1/2222 · maint1/3333 · obs1/4444  (운용 전 변경)")
    print("  종료: Ctrl+C")

    stop = threading.Event()

    def _shutdown(*_):
        if not stop.is_set():
            stop.set()
            threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _shutdown)
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        svc.stop()
        svc.db.close()
        httpd.server_close()
        print("UGCS 서버 종료 — 데이터 저장 완료")


if __name__ == "__main__":
    main()
