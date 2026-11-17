"""경보 판단 엔진 (Rule Engine).

텔레메트리 스냅샷을 규칙별로 평가하여 조건 성립 시 RAISE, 해소 시 CLEAR
이벤트를 만든다. 엔진 자체는 순수 로직(시간은 인자로 받음)이라 단위 테스트가 쉽고,
이벤트를 DB에 저장/방송하는 일은 서비스 계층이 맡는다.

snapshot 형식
    {
      "link": {"hb_age_s": float, "latency_ms": float, "loss_pct": float},
      "pos": {"lat", "lon", "alt"} | None,
      "battery_pct": float | None,
      "gps": {"fix": int, "sats": int} | None,
      "armed": bool, "mode": str,
      "mission_leg": [[lat, lon], [lat, lon]] | None   # 현재 비행 중인 임무 구간
    }
context 형식
    {"nfz": [{"name", "polygon"}], "geofence": [[lat, lon], ...] | None,
     "gcs": {"lat", "lon"} | None, "comm_radius_m": float}
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .. import config
from ..geo import (LocalProjection, distance_to_segment, haversine,
                   point_in_polygon)

CRITICAL, WARNING, INFO = "CRITICAL", "WARNING", "INFO"
SEVERITY_RANK = {CRITICAL: 3, WARNING: 2, INFO: 1}


@dataclass(frozen=True)
class Condition:
    severity: str
    message: str
    cause: str


@dataclass
class AlertEvent:
    type: str            # RAISE | CLEAR
    code: str
    severity: str
    message: str
    cause: str = ""

    def as_dict(self):
        return self.__dict__.copy()


RuleFn = Callable[[dict, dict, dict, set], dict[str, Condition]]


# ---------------------------------------------------------------------------
# 개별 규칙: (snapshot, context, cfg, 현재 활성 코드) -> {code: Condition}
# ---------------------------------------------------------------------------
def rule_link(s, ctx, cfg, active):
    link = s.get("link") or {}
    out = {}
    age = link.get("hb_age_s")
    if age is None or age > cfg["heartbeat_timeout_s"]:
        out["LINK_LOST"] = Condition(CRITICAL, "데이터링크 단절",
                                     f"Heartbeat {('수신 이력 없음' if age is None else f'{age:.1f}초 미수신')} "
                                     f"(제한 {cfg['heartbeat_timeout_s']:.0f}초)")
        return out  # 단절 시 지연/손실 판단은 무의미
    lat = link.get("latency_ms") or 0.0
    if lat >= cfg["latency_crit_ms"]:
        out["LINK_LATENCY"] = Condition(CRITICAL, "링크 지연 위험", f"지연 {lat:.0f} ms ≥ {cfg['latency_crit_ms']:.0f} ms")
    elif lat >= cfg["latency_warn_ms"]:
        out["LINK_LATENCY"] = Condition(WARNING, "링크 지연 초과", f"지연 {lat:.0f} ms ≥ {cfg['latency_warn_ms']:.0f} ms")
    loss = link.get("loss_pct") or 0.0
    if loss >= cfg["loss_warn_pct"]:
        out["LINK_LOSS"] = Condition(WARNING, "패킷 손실 증가", f"손실률 {loss:.0f}% ≥ {cfg['loss_warn_pct']:.0f}%")
    return out


def rule_battery(s, ctx, cfg, active):
    b = s.get("battery_pct")
    if b is None:
        return {}
    h = cfg["battery_hysteresis_pct"]
    crit_on = b <= cfg["battery_crit_pct"] or ("BATTERY_CRITICAL" in active and b <= cfg["battery_crit_pct"] + h)
    if crit_on:
        return {"BATTERY_CRITICAL": Condition(CRITICAL, "배터리 위험 — 즉시 복귀/착륙",
                                              f"잔량 {b:.1f}% ≤ {cfg['battery_crit_pct']:.0f}%")}
    warn_on = b <= cfg["battery_warn_pct"] or ("BATTERY_LOW" in active and b <= cfg["battery_warn_pct"] + h)
    if warn_on:
        return {"BATTERY_LOW": Condition(WARNING, "배터리 주의", f"잔량 {b:.1f}% ≤ {cfg['battery_warn_pct']:.0f}%")}
    return {}


def rule_gps(s, ctx, cfg, active):
    g = s.get("gps")
    if not g:
        return {}
    if g.get("fix", 0) < 3 or g.get("sats", 0) < cfg["min_sats"]:
        return {"GPS_DEGRADED": Condition(WARNING, "GNSS 수신 품질 저하",
                                          f"Fix {g.get('fix', 0)}D, 위성 {g.get('sats', 0)}개 (최소 {cfg['min_sats']}개)")}
    return {}


def rule_airspace(s, ctx, cfg, active):
    pos = s.get("pos")
    if not pos or not s.get("armed") or pos.get("alt", 0) < 1.0:
        return {}
    out = {}
    ref = ctx.get("gcs") or pos
    proj = LocalProjection(ref["lat"], ref["lon"])
    p = proj.to_xy(pos["lat"], pos["lon"])
    for z in ctx.get("nfz") or []:
        if point_in_polygon(p, proj.poly(z["polygon"])):
            out["NFZ_ENTRY"] = Condition(CRITICAL, "비행 금지구역 진입", f"'{z.get('name', 'NFZ')}' 내부 위치")
            break
    fence = ctx.get("geofence")
    if fence and len(fence) >= 3 and not point_in_polygon(p, proj.poly(fence)):
        out["GEOFENCE_BREACH"] = Condition(CRITICAL, "지오펜스 이탈", "임무 허용 구역 밖으로 벗어남")
    leg = s.get("mission_leg")
    if leg and s.get("mode") == "MISSION":
        a, b = proj.to_xy(*leg[0]), proj.to_xy(*leg[1])
        dev = distance_to_segment(p, a, b)
        if dev > cfg["route_deviation_m"]:
            out["ROUTE_DEVIATION"] = Condition(WARNING, "임무 경로 이탈",
                                               f"계획 경로에서 {dev:.0f} m 벗어남 (허용 {cfg['route_deviation_m']:.0f} m)")
    gcs = ctx.get("gcs")
    radius = ctx.get("comm_radius_m")
    if gcs and radius:
        r = haversine(gcs["lat"], gcs["lon"], pos["lat"], pos["lon"])
        if r > radius * cfg["range_warn_ratio"]:
            sev = CRITICAL if r > radius else WARNING
            out["COMM_RANGE"] = Condition(sev, "통신 유효 반경 근접" if sev == WARNING else "통신 유효 반경 초과",
                                          f"통제차량과 {r:.0f} m (반경 {radius:.0f} m)")
    return out


DEFAULT_RULES: tuple[RuleFn, ...] = (rule_link, rule_battery, rule_gps, rule_airspace)
# 링크 단절 시 텔레메트리가 낡았으므로 다음 규칙 결과는 동결(유지)한다
_STALE_ON_LINK_LOSS = {"BATTERY_LOW", "BATTERY_CRITICAL", "GPS_DEGRADED", "NFZ_ENTRY",
                       "GEOFENCE_BREACH", "ROUTE_DEVIATION", "COMM_RANGE", "LINK_LATENCY", "LINK_LOSS"}


class RuleEngine:
    def __init__(self, cfg: dict | None = None, rules: tuple[RuleFn, ...] = DEFAULT_RULES):
        self.cfg = dict(config.ALERT, **(cfg or {}))
        self.rules = rules
        self.active: dict[str, Condition] = {}     # 조건형 경보 (자동 해제)
        self.latched: dict[str, Condition] = {}    # 이벤트형 경보 (인지 시 해제)

    def evaluate(self, snapshot: dict, context: dict | None = None) -> list[AlertEvent]:
        ctx = context or {}
        now_on: dict[str, Condition] = {}
        codes = set(self.active)
        for rule in self.rules:
            now_on.update(rule(snapshot, ctx, self.cfg, codes))
        if "LINK_LOST" in now_on:
            for c in _STALE_ON_LINK_LOSS:
                if c in self.active:
                    now_on[c] = self.active[c]
        events: list[AlertEvent] = []
        for code, cond in list(self.active.items()):
            new = now_on.get(code)
            if new is None:
                events.append(AlertEvent("CLEAR", code, cond.severity, cond.message, "조건 해소"))
                del self.active[code]
            elif new.severity != cond.severity:
                events.append(AlertEvent("CLEAR", code, cond.severity, cond.message, "심각도 변경"))
                events.append(AlertEvent("RAISE", code, new.severity, new.message, new.cause))
                self.active[code] = new
            else:
                self.active[code] = new  # 원인 문구(수치) 갱신
        for code, cond in now_on.items():
            if code not in self.active:
                self.active[code] = cond
                events.append(AlertEvent("RAISE", code, cond.severity, cond.message, cond.cause))
        return events

    def raise_event(self, code: str, severity: str, message: str, cause: str) -> AlertEvent:
        """명령 시도 등 이벤트성 경보 (예: 정비 불가 기체 이륙 시도)."""
        self.latched[code] = Condition(severity, message, cause)
        return AlertEvent("RAISE", code, severity, message, cause)

    def clear_latched(self, code: str) -> Optional[AlertEvent]:
        c = self.latched.pop(code, None)
        return AlertEvent("CLEAR", code, c.severity, c.message, "운용자 인지") if c else None
