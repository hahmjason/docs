"""위치정보 수신 모듈 (GNSS / NMEA-0183).

- parse_nmea(): $GPGGA / $GNGGA / $GPRMC / $GNRMC 문장 파싱 + 체크섬 검증
- build_gga()/build_rmc(): 시뮬레이터가 실제 수신기와 같은 형식으로 문장을 생성
- GnssFix: 위도/경도/고도/헤딩/속도/Fix/위성 수 묶음
- AircraftGnssReceiver: 텔레메트리에 실린 기체 NMEA 문장을 파싱해 최신 Fix 유지
- GnssSource: 통제차량 자차 GNSS 입력 인터페이스
    · SimulatedVehicleGnss  — 내장 시뮬레이션 (정차/저속 이동 + 잡음)
    · SerialNmeaGnss        — 실제 수신기(USB/시리얼) 연결 시 사용 (pyserial 있을 때만)
- relative(): 기체-차량 간 직선거리/방위/통신 반경 내 여부
"""
from __future__ import annotations

import math
import random
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Optional

from ..geo import bearing, haversine


class NmeaError(ValueError):
    pass


@dataclass
class GnssFix:
    lat: float
    lon: float
    alt_msl: float = 0.0
    fix: int = 0              # 0=없음, 2=2D, 3=3D
    sats: int = 0
    hdop: float = 99.0
    speed_mps: float = 0.0
    course_deg: float = 0.0
    valid: bool = False
    t: float = field(default_factory=time.time)

    def as_dict(self):
        d = asdict(self)
        return {k: (round(v, 7) if isinstance(v, float) else v) for k, v in d.items()}


def nmea_checksum(body: str) -> str:
    c = 0
    for ch in body:
        c ^= ord(ch)
    return f"{c:02X}"


def _ddmm(value: float, is_lat: bool) -> tuple[str, str]:
    hemi = ("N" if value >= 0 else "S") if is_lat else ("E" if value >= 0 else "W")
    v = abs(value)
    deg = int(v)
    minutes = (v - deg) * 60
    return (f"{deg:02d}{minutes:08.5f}" if is_lat else f"{deg:03d}{minutes:08.5f}"), hemi


def _from_ddmm(s: str, hemi: str) -> float:
    if not s:
        raise NmeaError("empty coordinate")
    dot = s.index(".") if "." in s else len(s)
    deg = int(s[:dot - 2])
    minutes = float(s[dot - 2:])
    v = deg + minutes / 60.0
    return -v if hemi in ("S", "W") else v


def _wrap(body: str) -> str:
    return f"${body}*{nmea_checksum(body)}"


def build_gga(lat: float, lon: float, alt_msl: float, fix: int, sats: int, hdop: float,
              t: Optional[float] = None, talker: str = "GN") -> str:
    tm = time.gmtime(t if t is not None else time.time())
    la, lh = _ddmm(lat, True)
    lo, oh = _ddmm(lon, False)
    q = 0 if fix < 2 else 1
    return _wrap(f"{talker}GGA,{tm.tm_hour:02d}{tm.tm_min:02d}{tm.tm_sec:02d}.00,{la},{lh},{lo},{oh},"
                 f"{q},{sats:02d},{hdop:.1f},{alt_msl:.1f},M,0.0,M,,")


def build_rmc(lat: float, lon: float, speed_mps: float, course_deg: float, valid: bool = True,
              t: Optional[float] = None, talker: str = "GN") -> str:
    tm = time.gmtime(t if t is not None else time.time())
    la, lh = _ddmm(lat, True)
    lo, oh = _ddmm(lon, False)
    knots = speed_mps / 0.514444
    return _wrap(f"{talker}RMC,{tm.tm_hour:02d}{tm.tm_min:02d}{tm.tm_sec:02d}.00,{'A' if valid else 'V'},"
                 f"{la},{lh},{lo},{oh},{knots:.2f},{course_deg % 360:.1f},"
                 f"{tm.tm_mday:02d}{tm.tm_mon:02d}{tm.tm_year % 100:02d},,,A")


def parse_nmea(sentence: str) -> dict:
    """NMEA 문장 1개 → dict. 체크섬 불일치/형식 오류 시 NmeaError."""
    s = sentence.strip()
    if not s.startswith("$") or "*" not in s:
        raise NmeaError("not an NMEA sentence")
    body, cs = s[1:].split("*", 1)
    if nmea_checksum(body) != cs[:2].upper():
        raise NmeaError("checksum mismatch")
    f = body.split(",")
    kind = f[0][2:]
    try:
        if kind == "GGA":
            q = int(f[6] or 0)
            sats = int(f[7] or 0)
            out = {"type": "GGA", "fix_quality": q, "sats": sats,
                   "hdop": float(f[8] or 99), "alt_msl": float(f[9] or 0)}
            if q > 0:
                out["lat"] = _from_ddmm(f[2], f[3])
                out["lon"] = _from_ddmm(f[4], f[5])
            out["fix"] = 0 if q == 0 else (3 if sats >= 4 else 2)
            return out
        if kind == "RMC":
            valid = f[2] == "A"
            out = {"type": "RMC", "valid": valid,
                   "speed_mps": float(f[7] or 0) * 0.514444, "course_deg": float(f[8] or 0)}
            if valid:
                out["lat"] = _from_ddmm(f[3], f[4])
                out["lon"] = _from_ddmm(f[5], f[6])
            return out
    except (IndexError, ValueError) as e:
        raise NmeaError(f"malformed {kind}: {e}") from e
    raise NmeaError(f"unsupported sentence {kind}")


def fix_from_sentences(sentences: list[str], prev: Optional[GnssFix] = None) -> Optional[GnssFix]:
    """GGA(+RMC) 문장 묶음 → GnssFix. 파싱 불가 문장은 무시."""
    gga = rmc = None
    for s in sentences or []:
        try:
            p = parse_nmea(s)
        except NmeaError:
            continue
        if p["type"] == "GGA":
            gga = p
        elif p["type"] == "RMC":
            rmc = p
    if gga is None:
        return prev
    if "lat" not in gga:   # Fix 없음 → 마지막 위치 유지, 품질만 갱신
        if prev is None:
            return None
        return GnssFix(prev.lat, prev.lon, prev.alt_msl, 0, gga["sats"], gga["hdop"],
                       prev.speed_mps, prev.course_deg, False)
    return GnssFix(lat=gga["lat"], lon=gga["lon"], alt_msl=gga["alt_msl"], fix=gga["fix"], sats=gga["sats"],
                   hdop=gga["hdop"], speed_mps=(rmc or {}).get("speed_mps", 0.0),
                   course_deg=(rmc or {}).get("course_deg", 0.0), valid=gga["fix"] >= 2)


class AircraftGnssReceiver:
    """텔레메트리 메시지의 'gnss' 필드(NMEA 문장 배열)를 해석해 기체 위치를 갱신."""

    def __init__(self):
        self.fix: Optional[GnssFix] = None
        self.parse_errors = 0

    def ingest(self, telemetry: dict) -> Optional[GnssFix]:
        sentences = telemetry.get("gnss") or []
        for s in sentences:
            try:
                parse_nmea(s)
            except NmeaError:
                self.parse_errors += 1
        self.fix = fix_from_sentences(sentences, self.fix)
        return self.fix


class GnssSource:
    """통제 차량 자차 GNSS 입력 인터페이스."""
    name = "abstract"

    def read(self) -> Optional[GnssFix]:
        raise NotImplementedError

    def close(self):
        pass


class SimulatedVehicleGnss(GnssSource):
    """정차한 통제 차량(또는 저속 이동) GNSS. 실제 수신기처럼 NMEA를 만든 뒤 파싱한다."""
    name = "sim-vehicle-gnss"

    def __init__(self, lat: float, lon: float, alt_msl: float = 52.0, *, noise_m: float = 0.6, seed: int = 7):
        self.lat, self.lon, self.alt = lat, lon, alt_msl
        self.noise_m = noise_m
        self.speed = 0.0
        self.course = 0.0
        self._rng = random.Random(seed)
        self._mu = threading.Lock()
        self.last_sentences: list[str] = []

    def move_to(self, lat: float, lon: float):
        with self._mu:
            self.lat, self.lon = lat, lon

    def read(self) -> Optional[GnssFix]:
        with self._mu:
            k = self.noise_m / 111_320.0
            lat = self.lat + self._rng.gauss(0, k)
            lon = self.lon + self._rng.gauss(0, k / max(0.2, math.cos(math.radians(self.lat))))
            sats = 14 + self._rng.randint(-1, 2)
            self.last_sentences = [build_gga(lat, lon, self.alt, 3, sats, 0.8),
                                   build_rmc(lat, lon, self.speed, self.course)]
        return fix_from_sentences(self.last_sentences)


class SerialNmeaGnss(GnssSource):  # pragma: no cover - 하드웨어 필요
    """USB/시리얼 GNSS 수신기. pyserial이 설치된 경우에만 사용 (폐쇄망 반입 시 wheel 동봉)."""
    name = "serial-nmea"

    def __init__(self, port: str, baud: int = 9600):
        import serial  # type: ignore
        self._ser = serial.Serial(port, baud, timeout=0.2)
        self._last: Optional[GnssFix] = None
        self._pending: list[str] = []

    def read(self) -> Optional[GnssFix]:
        while self._ser.in_waiting:
            line = self._ser.readline().decode("ascii", "ignore").strip()
            if line.startswith("$"):
                self._pending.append(line)
                if line[3:6] == "RMC":
                    self._last = fix_from_sentences(self._pending, self._last)
                    self._pending = []
        return self._last

    def close(self):
        self._ser.close()


def relative(gcs: Optional[GnssFix | dict], aircraft: Optional[GnssFix | dict],
             comm_radius_m: float) -> Optional[dict]:
    """통제차량 → 기체 직선거리/방위각/반경 내 여부."""
    if not gcs or not aircraft:
        return None
    g = gcs if isinstance(gcs, dict) else gcs.as_dict()
    a = aircraft if isinstance(aircraft, dict) else aircraft.as_dict()
    d = haversine(g["lat"], g["lon"], a["lat"], a["lon"])
    return {"distance_m": round(d, 1), "bearing_deg": round(bearing(g["lat"], g["lon"], a["lat"], a["lon"]), 1),
            "in_range": d <= comm_radius_m, "range_ratio": round(d / comm_radius_m, 3) if comm_radius_m else None}
