"""UGCS - 무인기 지상통제 시스템 (Unmanned Ground Control System).

폐쇄망(Air-gapped) 차량 탑재 서버용으로 Python 표준 라이브러리만 사용한다.
계층:
    processing   ② 처리 (경로 계산, 경보 룰 엔진, RBAC/제어권)
    data         ③ 데이터 (SQLite 영속 계층)
    integration  ④ 시스템 연동 (데이터링크 어댑터, 시뮬레이터, GNSS)
    server       ⑤ 인프라 (로컬 HTTP/SSE 서버, 헬스체크)
    ../web       ① 화면 (조종 콘솔 UI, 정적 리소스)
"""

__version__ = "1.0.0"
