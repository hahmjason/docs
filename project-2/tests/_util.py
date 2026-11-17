import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ugcs.data.db import DEFAULT_GCS  # noqa: E402
from ugcs.geo import LocalProjection  # noqa: E402

HOME = dict(DEFAULT_GCS)
PROJ = LocalProjection(HOME["lat"], HOME["lon"])


def ll(x: float, y: float) -> list[float]:
    """기준점(통제차량)에서 동쪽 x m, 북쪽 y m 지점의 [lat, lon]."""
    lat, lon = PROJ.to_ll(x, y)
    return [lat, lon]


def wp(x, y, alt=50, speed=10, hold=0, action="WAYPOINT"):
    lat, lon = PROJ.to_ll(x, y)
    return {"lat": lat, "lon": lon, "alt": alt, "speed": speed, "hold": hold, "action": action}


def square(cx, cy, half):
    return [ll(cx - half, cy - half), ll(cx + half, cy - half), ll(cx + half, cy + half), ll(cx - half, cy + half)]
