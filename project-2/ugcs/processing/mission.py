"""임무 경로 계산기 & 사전 검증기.

입력: 이륙/복귀 지점(home), 웨이포인트 목록, 금지구역, 지오펜스, 시작 배터리.
출력: 구간별 거리·방위·고도변화·시간·배터리 소모 + 총계 + 검증 결과(issues).

시간 모델  : 구간시간 = max(수평거리/속도, |고도변화|/수직속도) + 체공시간
배터리 모델: 순항 drain × 비행시간 + 호버 drain × 체공시간 + 상승 1m당 drain
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable, Optional

from .. import config
from ..geo import (LocalProjection, bearing, haversine, point_in_polygon,
                   segment_intersects_polygon, segment_leaves_polygon)

ACTIONS = ("WAYPOINT", "LOITER", "PHOTO", "SURVEY", "LAND")


class MissionValidationError(ValueError):
    pass


@dataclass
class Waypoint:
    lat: float
    lon: float
    alt: float = 50.0
    speed: float = config.PERF["default_speed_mps"]
    hold: float = 0.0
    action: str = "WAYPOINT"

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Waypoint":
        try:
            wp = cls(lat=float(d["lat"]), lon=float(d["lon"]),
                     alt=float(d.get("alt", 50.0)),
                     speed=float(d.get("speed", config.PERF["default_speed_mps"])),
                     hold=float(d.get("hold", 0.0)),
                     action=str(d.get("action", "WAYPOINT")).upper())
        except (KeyError, TypeError, ValueError) as e:
            raise MissionValidationError(f"웨이포인트 형식 오류: {e}") from e
        if not (-90 <= wp.lat <= 90 and -180 <= wp.lon <= 180):
            raise MissionValidationError("위도/경도 범위를 벗어났습니다")
        if any(math.isnan(v) or math.isinf(v) for v in (wp.lat, wp.lon, wp.alt, wp.speed, wp.hold)):
            raise MissionValidationError("숫자가 아닌 값이 있습니다")
        return wp


@dataclass
class Issue:
    code: str
    severity: str          # ERROR(업로드 불가) | WARN
    message: str
    index: Optional[int] = None   # 관련 웨이포인트(0-based) 또는 구간 번호

    def as_dict(self):
        return asdict(self)


@dataclass
class Leg:
    index: int
    frm: str
    to: str
    distance_m: float
    distance_3d_m: float
    bearing_deg: float
    alt_from: float
    alt_to: float
    alt_change_m: float
    speed_mps: float
    time_s: float
    hold_s: float
    energy_pct: float
    battery_after_pct: float


@dataclass
class RoutePlan:
    legs: list[Leg] = field(default_factory=list)
    total_distance_m: float = 0.0
    total_distance_3d_m: float = 0.0
    total_time_s: float = 0.0
    energy_pct: float = 0.0
    battery_start_pct: float = 100.0
    battery_end_pct: float = 100.0
    max_alt_m: float = 0.0
    max_range_m: float = 0.0
    issues: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "ERROR" for i in self.issues)

    def as_dict(self) -> dict[str, Any]:
        d = {k: v for k, v in asdict(self).items() if k not in ("legs", "issues")}
        d["legs"] = [asdict(l) for l in self.legs]
        d["issues"] = [i.as_dict() for i in self.issues]
        d["ok"] = self.ok
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}


def _leg_energy(dist_m: float, dh: float, cruise_s: float, hold_s: float, perf: dict) -> float:
    e = cruise_s * perf["cruise_drain_pct_s"] + hold_s * perf["hover_drain_pct_s"]
    if dh > 0:
        e += dh * perf["climb_drain_pct_m"]
    return e


def compute_route(home: dict, waypoints: Iterable[dict | Waypoint], *,
                  start_battery_pct: float = 100.0, return_home: bool = True,
                  perf: dict | None = None) -> RoutePlan:
    """경로 계산 (검증 없이 수치만). home = {lat, lon, alt(지면 0)}."""
    perf = perf or config.PERF
    wps = [w if isinstance(w, Waypoint) else Waypoint.from_dict(w) for w in waypoints]
    plan = RoutePlan(battery_start_pct=start_battery_pct, battery_end_pct=start_battery_pct)
    h = Waypoint(lat=float(home["lat"]), lon=float(home["lon"]),
                 alt=float(home.get("alt", 0.0)), speed=perf["default_speed_mps"])
    pts: list[tuple[str, Waypoint]] = [("HOME", h)] + [(f"WP{i + 1}", w) for i, w in enumerate(wps)]
    if return_home and wps and wps[-1].action != "LAND":
        pts.append(("HOME", Waypoint(h.lat, h.lon, 0.0, wps[-1].speed)))

    battery = start_battery_pct
    for i in range(1, len(pts)):
        (na, a), (nb, b) = pts[i - 1], pts[i]
        d = haversine(a.lat, a.lon, b.lat, b.lon)
        dh = b.alt - a.alt
        v = max(b.speed, 0.1)
        vrate = perf["climb_rate_mps"] if dh >= 0 else perf["descent_rate_mps"]
        cruise_s = max(d / v, abs(dh) / vrate)
        hold_s = b.hold if nb != "HOME" else 0.0
        e = _leg_energy(d, dh, cruise_s, hold_s, perf)
        battery -= e
        leg = Leg(index=i - 1, frm=na, to=nb, distance_m=d, distance_3d_m=math.hypot(d, dh),
                  bearing_deg=bearing(a.lat, a.lon, b.lat, b.lon) if d > 0.01 else 0.0,
                  alt_from=a.alt, alt_to=b.alt, alt_change_m=dh, speed_mps=v,
                  time_s=cruise_s + hold_s, hold_s=hold_s, energy_pct=e, battery_after_pct=battery)
        plan.legs.append(leg)
        plan.total_distance_m += d
        plan.total_distance_3d_m += leg.distance_3d_m
        plan.total_time_s += leg.time_s
        plan.energy_pct += e
    plan.battery_end_pct = battery
    plan.max_alt_m = max((w.alt for w in wps), default=0.0)
    plan.max_range_m = max((haversine(h.lat, h.lon, w.lat, w.lon) for w in wps), default=0.0)
    return plan


def plan_mission(home: dict, waypoints: Iterable[dict], *, nfz: Iterable[dict] = (),
                 geofence: Optional[list] = None, start_battery_pct: float = 100.0,
                 return_home: bool = True, limits: dict | None = None,
                 perf: dict | None = None) -> RoutePlan:
    """경로 계산 + 사전 검증.

    nfz      : [{"name": str, "polygon": [[lat, lon], ...]}]
    geofence : [[lat, lon], ...] (임무 허용 구역, 없으면 검사 생략)
    """
    limits = limits or config.LIMITS
    raw = list(waypoints)
    issues: list[Issue] = []
    wps: list[Waypoint] = []
    for i, d in enumerate(raw):
        try:
            wps.append(Waypoint.from_dict(d))
        except MissionValidationError as e:
            issues.append(Issue("WP_INVALID", "ERROR", str(e), i))
    if issues:
        p = RoutePlan(battery_start_pct=start_battery_pct, battery_end_pct=start_battery_pct)
        p.issues = issues
        return p
    if not wps:
        p = RoutePlan(battery_start_pct=start_battery_pct, battery_end_pct=start_battery_pct)
        p.issues.append(Issue("NO_WAYPOINTS", "ERROR", "웨이포인트가 없습니다"))
        return p

    plan = compute_route(home, wps, start_battery_pct=start_battery_pct,
                         return_home=return_home, perf=perf)
    proj = LocalProjection(float(home["lat"]), float(home["lon"]))

    for i, w in enumerate(wps):
        if w.action not in ACTIONS:
            issues.append(Issue("WP_ACTION", "ERROR", f"WP{i + 1}: 알 수 없는 임무동작 '{w.action}'", i))
        if w.alt > limits["max_alt_m"]:
            issues.append(Issue("MAX_ALT", "ERROR",
                                f"WP{i + 1}: 고도 {w.alt:.0f} m가 최대 고도 {limits['max_alt_m']:.0f} m를 초과", i))
        if w.alt < limits["min_alt_m"] and w.action != "LAND":
            issues.append(Issue("MIN_ALT", "ERROR",
                                f"WP{i + 1}: 고도 {w.alt:.0f} m가 최저 안전고도 {limits['min_alt_m']:.0f} m 미만", i))
        if not (limits["min_speed_mps"] <= w.speed <= limits["max_speed_mps"]):
            issues.append(Issue("SPEED", "ERROR",
                                f"WP{i + 1}: 속도 {w.speed:.1f} m/s 허용 범위({limits['min_speed_mps']}~{limits['max_speed_mps']}) 밖", i))
        if w.hold < 0:
            issues.append(Issue("HOLD", "ERROR", f"WP{i + 1}: 체공시간은 0 이상이어야 합니다", i))
        r = haversine(float(home["lat"]), float(home["lon"]), w.lat, w.lon)
        if r > limits["max_range_m"]:
            issues.append(Issue("MAX_RANGE", "ERROR",
                                f"WP{i + 1}: 통제차량에서 {r / 1000:.2f} km — 통신 유효 반경 {limits['max_range_m'] / 1000:.1f} km 초과", i))
        elif r > limits["max_range_m"] * 0.9:
            issues.append(Issue("RANGE_MARGIN", "WARN", f"WP{i + 1}: 통신 반경 90% 이상 지점", i))

    if plan.total_distance_m > limits["max_route_m"]:
        issues.append(Issue("MAX_ROUTE", "ERROR",
                            f"총 비행거리 {plan.total_distance_m / 1000:.2f} km가 한계 {limits['max_route_m'] / 1000:.1f} km 초과"))

    # 구간 단위 공간 검증 (금지구역 교차 / 지오펜스 이탈)
    pts = [proj.to_xy(float(home["lat"]), float(home["lon"]))] + [proj.to_xy(w.lat, w.lon) for w in wps]
    if return_home and wps[-1].action != "LAND":
        pts.append(pts[0])
    for z in nfz or []:
        poly = proj.poly(z["polygon"])
        for i in range(1, len(pts)):
            if segment_intersects_polygon(pts[i - 1], pts[i], poly):
                issues.append(Issue("NFZ_CROSS", "ERROR",
                                    f"구간 {i}({plan.legs[i - 1].frm}→{plan.legs[i - 1].to})이 금지구역 '{z.get('name', 'NFZ')}'을 통과", i - 1))
    if geofence and len(geofence) >= 3:
        gpoly = proj.poly(geofence)
        if not point_in_polygon(pts[0], gpoly):
            issues.append(Issue("HOME_OUTSIDE_FENCE", "ERROR", "이륙 지점이 지오펜스 밖에 있습니다"))
        for i in range(1, len(pts)):
            if segment_leaves_polygon(pts[i - 1], pts[i], gpoly):
                issues.append(Issue("GEOFENCE", "ERROR",
                                    f"구간 {i}({plan.legs[i - 1].frm}→{plan.legs[i - 1].to})이 지오펜스를 벗어남", i - 1))

    reserve = limits["battery_reserve_pct"]
    if plan.battery_end_pct < reserve:
        issues.append(Issue("BATTERY", "ERROR",
                            f"예상 잔량 {plan.battery_end_pct:.1f}% — 예비량 {reserve:.0f}% 미만 (소모 {plan.energy_pct:.1f}%)"))
    elif plan.battery_end_pct < reserve + 10:
        issues.append(Issue("BATTERY_MARGIN", "WARN", f"예상 잔량 {plan.battery_end_pct:.1f}% — 여유 부족"))

    plan.issues = issues
    return plan
