"""시스템 설정값. 환경변수(UGCS_*)로 재정의할 수 있다."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = PROJECT_ROOT / "web"


def _env(name: str, default):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return type(default)(raw)


# ---- 인프라 -------------------------------------------------------------
HOST = _env("UGCS_HOST", "0.0.0.0")          # 차량 내부 LAN 전체에서 접속
PORT = _env("UGCS_PORT", 8080)
DB_PATH = Path(_env("UGCS_DB", str(PROJECT_ROOT / "data" / "ugcs.sqlite3")))
SESSION_TTL_S = _env("UGCS_SESSION_TTL", 12 * 3600)
LOOP_HZ = 5.0                                 # 경보 판단/브로드캐스트 주기
TELEMETRY_RECORD_HZ = 1.0                     # 비행 기록 저장 주기

# ---- 기체 성능 (경로 계산·시뮬레이터 공통) -----------------------------
PERF = {
    "climb_rate_mps": 3.0,
    "descent_rate_mps": 2.0,
    "land_rate_mps": 1.5,
    "cruise_drain_pct_s": 0.045,     # 순항 시 초당 배터리 소모(%)
    "hover_drain_pct_s": 0.055,      # 정지비행(호버) 시 초당 소모(%)
    "climb_drain_pct_m": 0.015,      # 상승 1 m당 추가 소모(%)
    "turn_rate_dps": 60.0,
    "default_speed_mps": 10.0,
}

# ---- 임무 검증 한계 -----------------------------------------------------
LIMITS = {
    "max_alt_m": 150.0,              # 최대 고도 (AGL)
    "min_alt_m": 5.0,
    "max_range_m": 5000.0,           # 통제차량으로부터 최대 거리 = 통신 유효 반경
    "max_route_m": 30000.0,          # 총 비행 거리 한계
    "min_speed_mps": 2.0,
    "max_speed_mps": 20.0,
    "battery_reserve_pct": 20.0,     # 착륙 시 남아야 하는 최소 배터리
}

# ---- 경보 임계치 --------------------------------------------------------
ALERT = {
    "heartbeat_timeout_s": 3.0,
    "latency_warn_ms": 400.0,
    "latency_crit_ms": 1200.0,
    "loss_warn_pct": 15.0,
    "battery_warn_pct": 30.0,
    "battery_crit_pct": 15.0,
    "battery_hysteresis_pct": 2.0,
    "route_deviation_m": 60.0,
    "min_sats": 6,
    "range_warn_ratio": 0.9,
}
