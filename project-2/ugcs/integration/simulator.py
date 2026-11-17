"""현실적인 기체(멀티콥터) 운동/전원 시뮬레이터.

- 비행 모드: LANDED → TAKEOFF → HOLD → MISSION → RTL → LAND (+ ESTOP)
- 위치 이동: 목표점으로 수평속도/상승률 제한, 기수는 선회율 제한, 바람 편류(외란)
- 배터리: 모드별 소모율(호버/순항/상승) × 소모 배율(장애 주입), 전압 곡선
- 페일세이프: GCS 하트비트 10초 단절 → RTL, 배터리 소진 → 강제 착륙
- GNSS: 실제 수신기와 같은 NMEA(GGA/RMC) 문장을 생성 (위성 수/Fix 저하 주입 가능)
"""
from __future__ import annotations

import math
import random
import threading
from dataclasses import dataclass, field
from typing import Optional

from .. import config
from ..geo import angle_diff, bearing, destination, haversine
from .gnss import build_gga, build_rmc

GROUND_ELEV_M = 50.0          # 훈련장 지면 표고 (MSL)
LINK_FAILSAFE_S = 10.0
RTL_MIN_ALT = 40.0


@dataclass
class SimFaults:
    battery_drain_x: float = 1.0      # 배터리 소모 배율
    wind_mps: float = 0.0             # 동→서 바람 편류 속도
    wind_dir_deg: float = 90.0        # 바람이 향하는 방위
    gps_degraded: bool = False        # 위성 수 급감 / 2D Fix


@dataclass
class VehicleState:
    lat: float
    lon: float
    alt: float = 0.0                  # 이륙 지점 기준 상대고도(AGL)
    heading: float = 0.0
    groundspeed: float = 0.0
    vspeed: float = 0.0
    roll: float = 0.0
    pitch: float = 0.0
    battery_pct: float = 100.0
    armed: bool = False
    mode: str = "LANDED"
    sats: int = 15
    fix: int = 3
    hdop: float = 0.7
    gimbal_pitch: float = -30.0
    gimbal_yaw: float = 0.0
    home: dict = field(default_factory=dict)


class VehicleSimulator:
    def __init__(self, lat: float, lon: float, *, perf: dict | None = None, seed: int = 42):
        self.perf = perf or config.PERF
        self.s = VehicleState(lat=lat, lon=lon, home={"lat": lat, "lon": lon})
        self.faults = SimFaults()
        self.mission: list[dict] = []
        self.wp_index = 0
        self._hold_left: Optional[float] = None
        self._takeoff_alt = 30.0
        self._start_after_takeoff = False
        self._paused_mode = None
        self._t = 0.0
        self._since_gcs_hb = 0.0
        self.failsafe: Optional[str] = None
        self._rng = random.Random(seed)
        self._mu = threading.RLock()

    # ---- 외부 인터페이스 --------------------------------------------------
    def reset(self, lat: Optional[float] = None, lon: Optional[float] = None):
        with self._mu:
            h = self.s.home
            self.s = VehicleState(lat=lat if lat is not None else h["lat"], lon=lon if lon is not None else h["lon"])
            self.s.home = {"lat": self.s.lat, "lon": self.s.lon}
            self.faults = SimFaults()
            self.mission, self.wp_index, self._hold_left, self.failsafe = [], 0, None, None

    def gcs_heartbeat(self):
        self._since_gcs_hb = 0.0

    def battery_drop(self, pct: float):
        with self._mu:
            self.s.battery_pct = max(0.0, self.s.battery_pct - pct)

    def load_mission(self, items: list[dict]) -> tuple[bool, str]:
        with self._mu:
            if self.s.mode == "MISSION":
                return False, "임무 수행 중에는 교체할 수 없습니다"
            self.mission = [dict(i) for i in items]
            self.wp_index = 0
            return True, f"{len(items)}개 항목 수신"

    def handle_command(self, cmd: str, params: dict) -> tuple[str, str]:
        """명령 처리 → (ACCEPTED|DENIED|FAILED, 메시지)."""
        with self._mu:
            s = self.s
            if cmd == "TAKEOFF":
                if s.armed:
                    return "DENIED", "이미 비행 중"
                if s.battery_pct < 25:
                    return "DENIED", "배터리 부족 — 이륙 불가"
                if self.faults.gps_degraded:
                    return "DENIED", "GNSS 3D Fix 없음 — 이륙 불가"
                s.armed, s.mode = True, "TAKEOFF"
                s.home = {"lat": s.lat, "lon": s.lon}
                self._takeoff_alt = float(params.get("alt", 30.0))
                self.failsafe = None
                return "ACCEPTED", f"이륙 고도 {self._takeoff_alt:.0f} m"
            if cmd == "START_MISSION":
                if not self.mission:
                    return "DENIED", "업로드된 임무 없음"
                if not s.armed:
                    s.armed, s.mode = True, "TAKEOFF"
                    s.home = {"lat": s.lat, "lon": s.lon}
                    self._takeoff_alt = float(self.mission[0].get("alt", 30))
                    self._start_after_takeoff = True
                    return "ACCEPTED", "자동 이륙 후 임무 시작"
                self.wp_index, self._hold_left, s.mode = 0, None, "MISSION"
                return "ACCEPTED", "임무 시작"
            if not s.armed and cmd in ("PAUSE", "RESUME", "RTL", "LAND"):
                return "DENIED", "지상 대기 중"
            if cmd == "PAUSE":
                self._paused_mode = s.mode
                s.mode = "HOLD"
                return "ACCEPTED", "현 위치 정지비행"
            if cmd == "RESUME":
                if not self.mission or self.wp_index >= len(self.mission):
                    return "DENIED", "재개할 임무 없음"
                s.mode = "MISSION"
                return "ACCEPTED", f"WP{self.wp_index + 1}부터 재개"
            if cmd == "RTL":
                s.mode = "RTL"
                return "ACCEPTED", "복귀 시작"
            if cmd == "LAND":
                s.mode = "LAND"
                return "ACCEPTED", "현 위치 착륙"
            if cmd == "ESTOP":
                s.mode = "ESTOP"
                return "ACCEPTED", "비상정지 — 모터 정지"
            if cmd == "GIMBAL":
                s.gimbal_pitch = max(-90.0, min(30.0, float(params.get("pitch", s.gimbal_pitch))))
                s.gimbal_yaw = max(-180.0, min(180.0, float(params.get("yaw", s.gimbal_yaw))))
                return "ACCEPTED", "짐벌 각도 변경"
            return "FAILED", f"지원하지 않는 명령 {cmd}"

    # ---- 물리 갱신 --------------------------------------------------------
    def _fly_to(self, lat: float, lon: float, alt: float, speed: float, dt: float) -> bool:
        s, p = self.s, self.perf
        d = haversine(s.lat, s.lon, lat, lon)
        brg = bearing(s.lat, s.lon, lat, lon) if d > 0.3 else s.heading
        # 기수 선회 (선회율 제한)
        turn = max(-p["turn_rate_dps"] * dt, min(p["turn_rate_dps"] * dt, angle_diff(s.heading, brg)))
        s.heading = (s.heading + turn) % 360
        # 수평 이동: 목표 방향으로, 기수 정렬 정도에 따라 감속
        align = max(0.2, math.cos(math.radians(angle_diff(s.heading, brg))))
        v_target = min(speed * align, d / max(dt, 1e-3), max(1.0, d * 0.6))
        s.groundspeed += max(-4 * dt, min(3 * dt, v_target - s.groundspeed))
        step = min(d, s.groundspeed * dt)
        if step > 0:
            s.lat, s.lon = destination(s.lat, s.lon, brg, step)
        # 수직
        dh = alt - s.alt
        vr = p["climb_rate_mps"] if dh > 0 else p["descent_rate_mps"]
        dz = max(-vr * dt, min(vr * dt, dh))
        s.alt += dz
        s.vspeed = dz / dt if dt else 0
        s.roll = max(-30, min(30, turn / dt * 0.35 if dt else 0))
        s.pitch = -min(15.0, s.groundspeed * 1.2)
        return d < 3.0 and abs(alt - s.alt) < 1.0

    def _wind(self, dt: float):
        f, s = self.faults, self.s
        if f.wind_mps > 0 and s.alt > 1:
            # 정지비행 모드는 위치유지 제어로 대부분 상쇄, 이동 중에는 직접 조준 방식이라 편류가 누적
            k = 1.0 if s.mode in ("MISSION", "RTL") else 0.05
            s.lat, s.lon = destination(s.lat, s.lon, f.wind_dir_deg, f.wind_mps * dt * k)

    def step(self, dt: float):
        with self._mu:
            s, p = self.s, self.perf
            self._t += dt
            self._since_gcs_hb += dt
            if s.armed:
                hover = s.groundspeed < 1.0
                drain = (p["hover_drain_pct_s"] if hover else p["cruise_drain_pct_s"]) * dt
                if s.vspeed > 0:
                    drain += s.vspeed * dt * p["climb_drain_pct_m"]
                s.battery_pct = max(0.0, s.battery_pct - drain * self.faults.battery_drain_x)
                # 페일세이프
                if s.mode not in ("RTL", "LAND", "ESTOP", "LANDED") and s.alt > 1:
                    if self._since_gcs_hb > LINK_FAILSAFE_S:
                        s.mode, self.failsafe = "RTL", "LINK_LOSS_RTL"
                    elif s.battery_pct <= 10:
                        s.mode, self.failsafe = "LAND", "BATTERY_LAND"
                if s.battery_pct <= 0 and s.mode != "ESTOP":
                    s.mode, self.failsafe = "LAND", "BATTERY_EMPTY"

            mode = s.mode
            if mode == "TAKEOFF":
                if self._fly_to(s.home["lat"], s.home["lon"], self._takeoff_alt, 0.0, dt) or s.alt >= self._takeoff_alt - 0.5:
                    if getattr(self, "_start_after_takeoff", False):
                        self._start_after_takeoff = False
                        self.wp_index, self._hold_left, s.mode = 0, None, "MISSION"
                    else:
                        s.mode = "HOLD"
            elif mode == "HOLD":
                s.groundspeed = max(0.0, s.groundspeed - 4 * dt)
                s.vspeed, s.roll, s.pitch = 0.0, 0.0, 0.0
            elif mode == "MISSION":
                self._step_mission(dt)
            elif mode == "RTL":
                h = s.home
                if haversine(s.lat, s.lon, h["lat"], h["lon"]) > 3:
                    target_alt = max(s.alt, RTL_MIN_ALT)
                    self._fly_to(h["lat"], h["lon"], target_alt, 12.0, dt)
                else:
                    s.mode = "LAND"
            elif mode == "LAND":
                s.groundspeed = max(0.0, s.groundspeed - 4 * dt)
                dz = min(p["land_rate_mps"] * dt, s.alt)
                s.alt -= dz
                s.vspeed = -dz / dt if dt else 0
                if s.alt <= 0.05:
                    self._touchdown()
            elif mode == "ESTOP":
                s.groundspeed = max(0.0, s.groundspeed - 6 * dt)
                dz = min(9.0 * dt, s.alt)
                s.alt -= dz
                s.vspeed = -dz / dt if dt else 0
                if s.alt <= 0.05:
                    self._touchdown(estop=True)
            if s.armed:
                self._wind(dt)
            self._step_gps()

    def _touchdown(self, estop: bool = False):
        s = self.s
        s.alt, s.vspeed, s.groundspeed, s.roll, s.pitch = 0.0, 0.0, 0.0, 0.0, 0.0
        s.armed = False
        s.mode = "LANDED"
        if estop:
            self.failsafe = "ESTOP"

    def _step_mission(self, dt: float):
        s = self.s
        if self.wp_index >= len(self.mission):
            last = self.mission[-1] if self.mission else {}
            s.mode = "LAND" if last.get("action") == "LAND" else "RTL"
            return
        wp = self.mission[self.wp_index]
        arrived = self._fly_to(float(wp["lat"]), float(wp["lon"]), float(wp.get("alt", 50)),
                               float(wp.get("speed", 10)), dt)
        if arrived:
            if self._hold_left is None:
                self._hold_left = float(wp.get("hold", 0) or 0)
            self._hold_left -= dt
            s.groundspeed = 0.0
            if self._hold_left <= 0:
                self._hold_left = None
                self.wp_index += 1

    def _step_gps(self):
        s = self.s
        if self.faults.gps_degraded:
            s.sats = max(3, min(5, s.sats + self._rng.choice((-1, 0, 1))))
            s.fix, s.hdop = 2, 4.5
        else:
            s.sats = max(11, min(18, s.sats + self._rng.choice((-1, 0, 0, 0, 1))))
            s.fix, s.hdop = 3, round(0.6 + (18 - s.sats) * 0.05, 2)

    # ---- 출력 --------------------------------------------------------------
    def current_leg(self) -> Optional[list]:
        """현재 수행 구간 [[lat,lon] 이전점, [lat,lon] 목표점] — 경로 이탈 판단용."""
        if self.s.mode != "MISSION" or not self.mission or self.wp_index >= len(self.mission):
            return None
        tgt = self.mission[self.wp_index]
        prev = self.mission[self.wp_index - 1] if self.wp_index > 0 else self.s.home
        return [[float(prev["lat"]), float(prev["lon"])], [float(tgt["lat"]), float(tgt["lon"])]]

    def telemetry(self, sys_time: float) -> dict:
        with self._mu:
            s = self.s
            volts = 19.8 + (25.2 - 19.8) * (s.battery_pct / 100.0) ** 0.8
            current = (0.4 if not s.armed else 18 + s.groundspeed * 0.9 + max(0, s.vspeed) * 3)
            return {
                "sys_time": sys_time,
                "gnss": [build_gga(s.lat, s.lon, GROUND_ELEV_M + s.alt, s.fix, s.sats, s.hdop, sys_time),
                         build_rmc(s.lat, s.lon, s.groundspeed, s.heading, s.fix >= 2, sys_time)],
                "alt_rel": round(s.alt, 2),
                "heading": round(s.heading, 1),
                "groundspeed": round(s.groundspeed, 2),
                "vspeed": round(s.vspeed, 2),
                "roll": round(s.roll, 1), "pitch": round(s.pitch, 1),
                "battery_pct": round(s.battery_pct, 2), "battery_v": round(volts, 2),
                "current_a": round(current, 1),
                "armed": s.armed, "mode": s.mode, "failsafe": self.failsafe,
                "wp_index": self.wp_index, "wp_total": len(self.mission),
                "mission_leg": self.current_leg(),
                "home": dict(s.home),
                "gimbal": {"pitch": s.gimbal_pitch, "yaw": s.gimbal_yaw},
            }
