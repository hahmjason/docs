"""데이터링크 프레임 프로토콜 (MAVLink v2 구조를 단순화한 형태).

    +-----+--------+-----+-------+-------+----------------+---------+
    | STX | LEN(2) | SEQ | SYSID | MSGID | PAYLOAD (JSON) | CRC(2)  |
    +-----+--------+-----+-------+-------+----------------+---------+
     0xFD   LE u16   u8    u8      u8      LEN bytes        X.25 CRC-16

CRC는 MAVLink와 동일한 X.25(CRC-16/MCRF4XX) 알고리즘으로 LEN~PAYLOAD 구간에 계산한다.
StreamParser는 시리얼/UDP 바이트 스트림에서 프레임 경계를 찾고 손상 프레임을 버린다.
→ 실제 MAVLink로 교체할 때는 이 모듈과 datalink 어댑터만 바꾸면 된다.
"""
from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from typing import Any

STX = 0xFD
HEADER = struct.Struct("<BHBBB")   # stx, len, seq, sysid, msgid
MAX_PAYLOAD = 4096

HEARTBEAT = 0
TELEMETRY = 1
MISSION_ITEM = 39
MISSION_COUNT = 44
MISSION_ACK = 47
COMMAND = 76
COMMAND_ACK = 77
GCS_HEARTBEAT = 255

MSG_NAMES = {HEARTBEAT: "HEARTBEAT", TELEMETRY: "TELEMETRY", MISSION_ITEM: "MISSION_ITEM",
             MISSION_COUNT: "MISSION_COUNT", MISSION_ACK: "MISSION_ACK", COMMAND: "COMMAND",
             COMMAND_ACK: "COMMAND_ACK", GCS_HEARTBEAT: "GCS_HEARTBEAT"}


class FrameError(ValueError):
    pass


@dataclass
class Frame:
    seq: int
    sysid: int
    msgid: int
    payload: dict[str, Any]

    @property
    def name(self) -> str:
        return MSG_NAMES.get(self.msgid, str(self.msgid))


def crc16_x25(data: bytes, crc: int = 0xFFFF) -> int:
    for b in data:
        tmp = b ^ (crc & 0xFF)
        tmp = (tmp ^ (tmp << 4)) & 0xFF
        crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xFFFF
    return crc


def encode(seq: int, msgid: int, payload: dict[str, Any], sysid: int = 1) -> bytes:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_PAYLOAD:
        raise FrameError("payload too large")
    head = HEADER.pack(STX, len(body), seq & 0xFF, sysid & 0xFF, msgid & 0xFF)
    crc = crc16_x25(head[1:] + body)
    return head + body + struct.pack("<H", crc)


def decode(frame: bytes) -> Frame:
    if len(frame) < HEADER.size + 2:
        raise FrameError("short frame")
    stx, ln, seq, sysid, msgid = HEADER.unpack_from(frame)
    if stx != STX:
        raise FrameError("bad STX")
    if len(frame) != HEADER.size + ln + 2:
        raise FrameError("length mismatch")
    body = frame[HEADER.size:HEADER.size + ln]
    (crc,) = struct.unpack_from("<H", frame, HEADER.size + ln)
    if crc16_x25(frame[1:HEADER.size] + body) != crc:
        raise FrameError("CRC mismatch")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise FrameError(f"bad payload: {e}") from e
    return Frame(seq, sysid, msgid, payload)


class StreamParser:
    """바이트 스트림 → 프레임. 깨진 바이트는 건너뛰고 다음 STX에서 재동기화."""

    def __init__(self):
        self.buf = bytearray()
        self.errors = 0

    def feed(self, data: bytes) -> list[Frame]:
        self.buf += data
        out: list[Frame] = []
        while True:
            i = self.buf.find(bytes([STX]))
            if i < 0:
                self.buf.clear()
                return out
            if i:
                del self.buf[:i]
            if len(self.buf) < HEADER.size:
                return out
            ln = struct.unpack_from("<H", self.buf, 1)[0]
            if ln > MAX_PAYLOAD:
                self.errors += 1
                del self.buf[:1]
                continue
            total = HEADER.size + ln + 2
            if len(self.buf) < total:
                return out
            chunk = bytes(self.buf[:total])
            try:
                out.append(decode(chunk))
                del self.buf[:total]
            except FrameError:
                self.errors += 1
                del self.buf[:1]
