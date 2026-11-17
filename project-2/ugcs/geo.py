"""측지/평면 기하 유틸리티 (외부 라이브러리 없음).

- 거리/방위: WGS-84 평균 반경 기반 Haversine
- 다각형 판정: 기준점 중심 국지 평면(ENU, equirectangular) 투영 후 계산
  (임무 영역 수 km 범위에서 오차 0.1% 미만)
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

EARTH_R = 6371008.8  # m

LatLon = Sequence[float]          # (lat, lon)
XY = tuple[float, float]


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 위경도 사이 대권거리(m)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(a)))


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """초기 방위각(도, 진북 기준 0~360)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def destination(lat: float, lon: float, brg_deg: float, dist_m: float) -> tuple[float, float]:
    """시작점에서 방위/거리만큼 이동한 지점."""
    d = dist_m / EARTH_R
    b = math.radians(brg_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1),
                         math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540.0) % 360.0 - 180.0


def angle_diff(a: float, b: float) -> float:
    """b - a 를 -180~180 범위로."""
    return (b - a + 540.0) % 360.0 - 180.0


class LocalProjection:
    """기준점 중심 국지 평면 투영 (x=동, y=북, 단위 m)."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self._kx = math.radians(1) * EARTH_R * math.cos(math.radians(lat0))
        self._ky = math.radians(1) * EARTH_R

    def to_xy(self, lat: float, lon: float) -> XY:
        return ((lon - self.lon0) * self._kx, (lat - self.lat0) * self._ky)

    def to_ll(self, x: float, y: float) -> tuple[float, float]:
        return (self.lat0 + y / self._ky, self.lon0 + x / self._kx)

    def poly(self, ring: Iterable[LatLon]) -> list[XY]:
        return [self.to_xy(p[0], p[1]) for p in ring]


def point_in_polygon(pt: XY, poly: Sequence[XY]) -> bool:
    """Ray casting. 경계 위 점은 내부로 간주하지 않을 수 있음(수치 오차 범위)."""
    x, y = pt
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            xc = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < xc:
                inside = not inside
        j = i
    return inside


def _orient(a: XY, b: XY, c: XY) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_seg(a: XY, b: XY, c: XY) -> bool:
    return min(a[0], b[0]) - 1e-9 <= c[0] <= max(a[0], b[0]) + 1e-9 and \
        min(a[1], b[1]) - 1e-9 <= c[1] <= max(a[1], b[1]) + 1e-9


def segments_intersect(p1: XY, p2: XY, q1: XY, q2: XY) -> bool:
    d1, d2 = _orient(q1, q2, p1), _orient(q1, q2, p2)
    d3, d4 = _orient(p1, p2, q1), _orient(p1, p2, q2)
    if ((d1 > 0) != (d2 > 0)) and ((d3 > 0) != (d4 > 0)) and d1 and d2 and d3 and d4:
        return True
    if d1 == 0 and _on_seg(q1, q2, p1):
        return True
    if d2 == 0 and _on_seg(q1, q2, p2):
        return True
    if d3 == 0 and _on_seg(p1, p2, q1):
        return True
    if d4 == 0 and _on_seg(p1, p2, q2):
        return True
    return False


def segment_intersects_polygon(a: XY, b: XY, poly: Sequence[XY]) -> bool:
    """선분이 다각형 내부를 지나거나 경계와 교차하면 True."""
    if point_in_polygon(a, poly) or point_in_polygon(b, poly):
        return True
    n = len(poly)
    return any(segments_intersect(a, b, poly[i], poly[(i + 1) % n]) for i in range(n))


def segment_leaves_polygon(a: XY, b: XY, poly: Sequence[XY]) -> bool:
    """두 끝점이 내부여도 경계를 넘어 나갔다 들어오면 True (오목 지오펜스 대응)."""
    if not (point_in_polygon(a, poly) and point_in_polygon(b, poly)):
        return True
    n = len(poly)
    return any(segments_intersect(a, b, poly[i], poly[(i + 1) % n]) for i in range(n))


def distance_to_segment(p: XY, a: XY, b: XY) -> float:
    """점과 선분 사이 최소 거리(m) — 경로 이탈(Cross-track) 판단용."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
