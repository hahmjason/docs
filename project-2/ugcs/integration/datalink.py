"""데이터링크 송수신 모듈.

DataLinkAdapter (추상 인터페이스)
    start() / stop()
    on_telemetry(cb)                       — 기체 텔레메트리 수신 콜백 등록
    send_command(cmd, params) -> Ack       — 명령 송신 + ACK 확인(타임아웃·재전송)
    upload_mission(items) -> Ack           — 임무 업로드(COUNT → ITEM… → MISSION_ACK)
    stats() -> dict                        — 연결 상태, Heartbeat 경과, 지연, 손실률, RSSI

구현체
    SimulatedDataLink  — 내장 기체 시뮬레이터 + 가상 RF 채널(단절/지연/손실 주입)
    UdpDataLink        — 동일 프레임 프로토콜을 UDP로 송수신 (실기체/외부 시뮬레이터 연결용)
실제 MAVLink 장비로 교체 시 같은 인터페이스로 MavlinkDataLink를 추가하면 상위 계층은 그대로다.
"""
from __future__ import annotations

import heapq
import itertools
import math
import random
import socket
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional

from ..geo import haversine
from . import protocol as P
from .simulator import VehicleSimulator

TelemetryCallback = Callable[[dict], None]


class LinkTimeout(Exception):
    """재전송 후에도 ACK 미수신."""


@dataclass
class Ack:
    ok: bool
    result: str          # ACCEPTED | DENIED | FAILED | TIMEOUT
    message: str = ""
    attempts: int = 1
    rtt_ms: float = 0.0

    def as_dict(self):
        return dict(self.__dict__)


class DataLinkAdapter(ABC):
    name = "abstract"

    def __init__(self):
        self._callbacks: list[TelemetryCallback] = []

    def on_telemetry(self, cb: TelemetryCallback):
        self._callbacks.append(cb)

    def _emit(self, telemetry: dict):
        for cb in list(self._callbacks):
            try:
                cb(telemetry)
            except Exception:  # 수신 처리 오류가 링크 스레드를 죽이지 않도록
                import traceback
                traceback.print_exc()

    @abstractmethod
    def start(self): ...

    @abstractmethod
    def stop(self): ...

    @abstractmethod
    def send_command(self, command: str, params: dict | None = None, *,
                     timeout: float = 1.0, retries: int = 3) -> Ack: ...

    @abstractmethod
    def upload_mission(self, items: list[dict], *, timeout: float = 1.5, retries: int = 3) -> Ack: ...

    @abstractmethod
    def stats(self) -> dict: ...


# ---------------------------------------------------------------------------
# GCS 측 공통 수신 처리 (프레임 → 상태/ACK 대기열)
# ---------------------------------------------------------------------------
class _GcsEndpoint:
    def __init__(self, emit: TelemetryCallback):
        self.emit = emit
        self.parser = P.StreamParser()
        self.last_hb: Optional[float] = None
        self.last_rx: Optional[float] = None
        self.latency_ms = 0.0
        self.rx_frames = 0
        self.tx_frames = 0
        self._expected_seq: Optional[int] = None
        self._win_recv = 0
        self._win_lost = 0
        self.loss_pct = 0.0
        self.vehicle_status: dict = {}
        self._pending: dict[int, tuple[threading.Event, dict]] = {}
        self._mu = threading.Lock()
        self._tx_seq = itertools.count()
        self._cmd_ids = itertools.count(1)

    def next_seq(self) -> int:
        return next(self._tx_seq) & 0xFF

    def new_cmd_id(self) -> int:
        return next(self._cmd_ids)

    def expect(self, key: int) -> tuple[threading.Event, dict]:
        ev, box = threading.Event(), {}
        with self._mu:
            self._pending[key] = (ev, box)
        return ev, box

    def forget(self, key: int):
        with self._mu:
            self._pending.pop(key, None)

    def _track_seq(self, seq: int):
        if self._expected_seq is not None:
            gap = (seq - self._expected_seq) & 0xFF
            if gap < 128:          # 순서 역전/중복은 무시
                self._win_lost += gap
        self._expected_seq = (seq + 1) & 0xFF
        self._win_recv += 1
        total = self._win_recv + self._win_lost
        if total >= 20:            # 슬라이딩 윈도우 대략 4초(5Hz)
            self.loss_pct = 0.7 * self.loss_pct + 0.3 * (100.0 * self._win_lost / total)
            self._win_recv = self._win_lost = 0

    def receive_bytes(self, data: bytes, now: float):
        for fr in self.parser.feed(data):
            self.rx_frames += 1
            if self.last_rx is not None and now - self.last_rx > 2.0:
                self._expected_seq = None     # 단절 구간은 LINK_LOST로 판단 — 손실률 통계에서 제외
            self.last_rx = now
            self._track_seq(fr.seq)     # 기체 송신 순번 공통 → 누락 = 손실
            if fr.msgid == P.HEARTBEAT:
                self.last_hb = now
                self.vehicle_status = fr.payload
            elif fr.msgid == P.TELEMETRY:
                st = fr.payload.get("sys_time")
                if st is not None:
                    lat = max(0.0, (now - st) * 1000.0)
                    self.latency_ms = lat if self.latency_ms == 0 else 0.8 * self.latency_ms + 0.2 * lat
                self.emit(fr.payload)
            elif fr.msgid in (P.COMMAND_ACK, P.MISSION_ACK):
                key = fr.payload.get("cmd_id")
                with self._mu:
                    w = self._pending.get(key)
                if w:
                    w[1].update(fr.payload)
                    w[0].set()

    def request(self, send: Callable[[bytes], None], frames_for_attempt: Callable[[int], list[bytes]],
                key: int, timeout: float, retries: int) -> Ack:
        t0 = time.monotonic()
        for attempt in range(1, retries + 1):
            ev, box = self.expect(key)
            for f in frames_for_attempt(attempt):
                self.tx_frames += 1
                send(f)
            if ev.wait(timeout):
                self.forget(key)
                res = box.get("result", "FAILED")
                if res == "INCOMPLETE" and attempt < retries:
                    continue
                return Ack(res == "ACCEPTED", res, box.get("message", ""), attempt,
                           round((time.monotonic() - t0) * 1000, 1))
            self.forget(key)
        raise LinkTimeout(f"{retries}회 재전송 후 ACK 미수신")

    def stats(self, now: float) -> dict:
        hb_age = None if self.last_hb is None else round(now - self.last_hb, 2)
        return {"connected": hb_age is not None and hb_age < 3.0, "hb_age_s": hb_age,
                "latency_ms": round(self.latency_ms, 1), "loss_pct": round(self.loss_pct, 1),
                "rx_frames": self.rx_frames, "tx_frames": self.tx_frames, "crc_errors": self.parser.errors}


# ---------------------------------------------------------------------------
# 가상 RF 채널 (지연·지터·손실·단절 주입)
# ---------------------------------------------------------------------------
class Channel:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.down = False
        self.latency_ms = 25.0
        self.jitter_ms = 8.0
        self.loss_pct = 0.0
        self.extra_loss_pct = 0.0     # 거리 기반 추가 손실
        self.corrupt_pct = 0.0        # 비트 오류(CRC 검증 대상)
        self._q: list[tuple[float, int, bytes]] = []
        self._last_due = 0.0
        self._n = itertools.count()
        self._mu = threading.Lock()

    def send(self, frame: bytes, now: float):
        if self.down:
            return
        if self.rng.random() * 100 < self.loss_pct + self.extra_loss_pct:
            return
        if self.corrupt_pct and self.rng.random() * 100 < self.corrupt_pct:
            b = bytearray(frame)
            b[self.rng.randrange(6, len(b))] ^= 0x5A
            frame = bytes(b)
        delay = max(0.0, self.latency_ms + self.rng.uniform(-self.jitter_ms, self.jitter_ms)) / 1000.0
        with self._mu:
            # 직렬 무선링크는 순서를 바꾸지 않으므로 FIFO 유지 (지터는 지연량에만 반영)
            t = max(now + delay, self._last_due)
            self._last_due = t
            heapq.heappush(self._q, (t, next(self._n), frame))

    def due(self, now: float) -> list[bytes]:
        out = []
        with self._mu:
            while self._q and self._q[0][0] <= now:
                out.append(heapq.heappop(self._q)[2])
            if self.down:
                self._q.clear()
        return out


class SimulatedDataLink(DataLinkAdapter):
    """내장 시뮬레이터 연결. tick()이 기체 물리·채널 전달·송수신을 한 번에 진행한다."""
    name = "sim-datalink"

    def __init__(self, sim: VehicleSimulator, *, gcs_position: Callable[[], Optional[dict]] | None = None,
                 comm_radius_m: float = 5000.0, tick_hz: float = 50.0, telem_hz: float = 5.0, seed: int = 1):
        super().__init__()
        self.sim = sim
        self.gcs_position = gcs_position or (lambda: None)
        self.comm_radius_m = comm_radius_m
        self.tick_hz, self.telem_hz = tick_hz, telem_hz
        rng = random.Random(seed)
        self.up, self.downlink = Channel(rng), Channel(rng)
        self.gcs = _GcsEndpoint(self._emit)
        self._veh_parser = P.StreamParser()
        self._veh_seq = itertools.count()
        self._mission_rx: dict[int, dict] = {}
        self._mu = threading.RLock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last: Optional[float] = None
        self._next_telem = 0.0
        self._next_hb = 0.0
        self._next_gcs_hb = 0.0
        self.rssi_dbm = -50.0
        self.started_at = time.monotonic()

    # ---- 장애 주입 -------------------------------------------------------
    def set_faults(self, *, link_down: Optional[bool] = None, latency_ms: Optional[float] = None,
                   loss_pct: Optional[float] = None, corrupt_pct: Optional[float] = None):
        for ch in (self.up, self.downlink):
            if link_down is not None:
                ch.down = bool(link_down)
            if latency_ms is not None:
                ch.latency_ms = max(0.0, float(latency_ms))   # 편도 지연(ms)
            if loss_pct is not None:
                ch.loss_pct = max(0.0, min(100.0, float(loss_pct)))
            if corrupt_pct is not None:
                ch.corrupt_pct = max(0.0, min(100.0, float(corrupt_pct)))

    def faults(self) -> dict:
        return {"link_down": self.up.down, "latency_ms": self.up.latency_ms,
                "loss_pct": self.up.loss_pct, "corrupt_pct": self.up.corrupt_pct}

    # ---- 생명주기 --------------------------------------------------------
    def start(self):
        if self._thread:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="sim-datalink", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self._thread = None

    def _run(self):
        period = 1.0 / self.tick_hz
        while not self._stop.is_set():
            self.tick(time.monotonic())
            self._stop.wait(period)

    # ---- 한 주기 처리 ----------------------------------------------------
    def tick(self, now: float):
        with self._mu:
            dt = 0.0 if self._last is None else min(0.5, now - self._last)
            self._last = now
            if dt:
                self.sim.step(dt)
            self._update_rf()
            # 기체 → GCS
            if now >= self._next_telem:
                self._next_telem = now + 1.0 / self.telem_hz
                self.downlink.send(P.encode(next(self._veh_seq), P.TELEMETRY, self.sim.telemetry(now)), now)
            if now >= self._next_hb:
                self._next_hb = now + 1.0
                s = self.sim.s
                self.downlink.send(P.encode(next(self._veh_seq), P.HEARTBEAT,
                                            {"mode": s.mode, "armed": s.armed, "type": "QUADROTOR"}), now)
            # GCS → 기체 하트비트
            if now >= self._next_gcs_hb:
                self._next_gcs_hb = now + 1.0
                self.up.send(P.encode(self.gcs.next_seq(), P.GCS_HEARTBEAT, {}, sysid=255), now)
            for raw in self.up.due(now):
                self._vehicle_receive(raw, now)
            for raw in self.downlink.due(now):
                self.gcs.receive_bytes(raw, now)

    def _update_rf(self):
        gcs = self.gcs_position()
        if not gcs:
            return
        s = self.sim.s
        d = max(1.0, haversine(gcs["lat"], gcs["lon"], s.lat, s.lon))
        self.rssi_dbm = round(-38.0 - 20 * math.log10(d / 50.0) if d > 50 else -38.0, 1)
        ratio = d / self.comm_radius_m
        extra = 0.0 if ratio < 0.9 else min(100.0, (ratio - 0.9) / 0.3 * 100.0)
        self.up.extra_loss_pct = self.downlink.extra_loss_pct = extra

    def _vehicle_receive(self, raw: bytes, now: float):
        for fr in self._veh_parser.feed(raw):
            if fr.msgid == P.GCS_HEARTBEAT:
                self.sim.gcs_heartbeat()
            elif fr.msgid == P.COMMAND:
                self.sim.gcs_heartbeat()
                res, msg = self.sim.handle_command(fr.payload["command"], fr.payload.get("params") or {})
                self.downlink.send(P.encode(next(self._veh_seq), P.COMMAND_ACK,
                                            {"cmd_id": fr.payload["cmd_id"], "command": fr.payload["command"],
                                             "result": res, "message": msg}), now)
            elif fr.msgid == P.MISSION_COUNT:
                self._mission_rx[fr.payload["cmd_id"]] = {"count": fr.payload["count"], "items": {}}
            elif fr.msgid == P.MISSION_ITEM:
                st = self._mission_rx.get(fr.payload["cmd_id"])
                if st is None:
                    continue
                st["items"][fr.payload["seq"]] = fr.payload["item"]
                if fr.payload["seq"] == st["count"] - 1 or len(st["items"]) == st["count"]:
                    if len(st["items"]) == st["count"]:
                        ok, msg = self.sim.load_mission([st["items"][i] for i in range(st["count"])])
                        res = "ACCEPTED" if ok else "DENIED"
                    else:
                        res, msg = "INCOMPLETE", f"{st['count'] - len(st['items'])}개 항목 누락"
                    self.downlink.send(P.encode(next(self._veh_seq), P.MISSION_ACK,
                                                {"cmd_id": fr.payload["cmd_id"], "result": res, "message": msg}), now)

    # ---- GCS API -------------------------------------------------------
    def _send_up(self, frame: bytes):
        self.up.send(frame, time.monotonic())

    def send_command(self, command: str, params: dict | None = None, *, timeout: float = 1.0, retries: int = 3) -> Ack:
        cid = self.gcs.new_cmd_id()
        body = {"cmd_id": cid, "command": command.upper(), "params": params or {}}
        return self.gcs.request(self._send_up, lambda a: [P.encode(self.gcs.next_seq(), P.COMMAND, body, 255)],
                                cid, timeout, retries)

    def upload_mission(self, items: list[dict], *, timeout: float = 1.5, retries: int = 3) -> Ack:
        cid = self.gcs.new_cmd_id()

        def frames(_attempt):
            out = [P.encode(self.gcs.next_seq(), P.MISSION_COUNT, {"cmd_id": cid, "count": len(items)}, 255)]
            for i, it in enumerate(items):
                out.append(P.encode(self.gcs.next_seq(), P.MISSION_ITEM, {"cmd_id": cid, "seq": i, "item": it}, 255))
            return out
        return self.gcs.request(self._send_up, frames, cid, timeout, retries)

    def stats(self) -> dict:
        st = self.gcs.stats(time.monotonic())
        st.update({"adapter": self.name, "rssi_dbm": self.rssi_dbm if st["connected"] else None,
                   "faults": self.faults()})
        return st


class UdpDataLink(DataLinkAdapter):  # pragma: no cover - 외부 장비 필요
    """같은 프레임 프로토콜을 UDP로 주고받는 어댑터 (차량 LAN의 무선 모뎀/외부 SITL 연결)."""
    name = "udp-datalink"

    def __init__(self, bind=("0.0.0.0", 14550), remote=("192.168.10.2", 14555)):
        super().__init__()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(bind)
        self.sock.settimeout(0.2)
        self.remote = remote
        self.gcs = _GcsEndpoint(self._emit)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        next_hb = 0.0
        while not self._stop.is_set():
            now = time.monotonic()
            if now >= next_hb:
                next_hb = now + 1
                self.sock.sendto(P.encode(self.gcs.next_seq(), P.GCS_HEARTBEAT, {}, 255), self.remote)
            try:
                data, _ = self.sock.recvfrom(65535)
                self.gcs.receive_bytes(data, time.monotonic())
            except socket.timeout:
                pass

    def stop(self):
        self._stop.set()
        self.sock.close()

    def send_command(self, command, params=None, *, timeout=1.0, retries=3):
        cid = self.gcs.new_cmd_id()
        body = {"cmd_id": cid, "command": command.upper(), "params": params or {}}
        return self.gcs.request(lambda f: self.sock.sendto(f, self.remote),
                                lambda a: [P.encode(self.gcs.next_seq(), P.COMMAND, body, 255)], cid, timeout, retries)

    def upload_mission(self, items, *, timeout=1.5, retries=3):
        cid = self.gcs.new_cmd_id()
        frames = lambda a: [P.encode(self.gcs.next_seq(), P.MISSION_COUNT, {"cmd_id": cid, "count": len(items)}, 255)] + \
            [P.encode(self.gcs.next_seq(), P.MISSION_ITEM, {"cmd_id": cid, "seq": i, "item": it}, 255)
             for i, it in enumerate(items)]
        return self.gcs.request(lambda f: self.sock.sendto(f, self.remote), frames, cid, timeout, retries)

    def stats(self):
        st = self.gcs.stats(time.monotonic())
        st.update({"adapter": self.name, "rssi_dbm": None, "faults": {}})
        return st
