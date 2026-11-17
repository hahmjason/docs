"""조작 권한 확인: 역할 기반 접근제어(RBAC) + 단일 제어권(Active Control Lock).

비행 제어 명령은 두 단계를 모두 통과해야 실행된다.
  1) 역할이 해당 명령 권한을 가지고 있는가     (예: OBSERVER → 거부)
  2) 요청자가 현재 제어권(Control Lock) 보유자인가 (예: 제어권 없는 PILOT → 거부)
실패 시 AuthorizationError(status=403)를 던지며, API 계층이 403 + 감사 로그로 처리한다.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional


class Role(str, Enum):
    PILOT = "PILOT"                # 조종사
    MISSION_CTRL = "MISSION_CTRL"  # 임무통제관
    MAINTENANCE = "MAINTENANCE"    # 정비사
    OBSERVER = "OBSERVER"          # 관찰자


ROLE_LABEL = {Role.PILOT: "조종사", Role.MISSION_CTRL: "임무통제관",
              Role.MAINTENANCE: "정비사", Role.OBSERVER: "관찰자"}

# 비행 제어 명령 (제어권 필수)
FLIGHT_COMMANDS = ("TAKEOFF", "UPLOAD_MISSION", "START_MISSION", "PAUSE", "RESUME",
                   "RTL", "LAND", "ESTOP", "GIMBAL")
# 위험 명령: UI 2차 확인 + 서버측 confirm 토큰 요구
DANGEROUS_COMMANDS = {"ESTOP": "ESTOP", "RTL": "RTL", "LAND": "LAND"}

_READ = {"state.read", "mission.read", "flight.read", "maint.read", "alert.read"}
_FLIGHT = {f"cmd.{c}" for c in FLIGHT_COMMANDS}

PERMISSIONS: dict[Role, frozenset[str]] = {
    Role.PILOT: frozenset(_READ | _FLIGHT | {"control.acquire", "alert.ack", "mission.write"}),
    Role.MISSION_CTRL: frozenset(_READ | _FLIGHT | {
        "control.acquire", "control.force", "alert.ack", "mission.write",
        "mission.approve", "mission.archive", "sim.control", "audit.read"}),
    Role.MAINTENANCE: frozenset(_READ | {"maint.write", "aircraft.status", "sim.control", "alert.ack"}),
    Role.OBSERVER: frozenset(_READ),
}


class AuthorizationError(Exception):
    status = 403

    def __init__(self, reason: str, code: str = "FORBIDDEN"):
        super().__init__(reason)
        self.reason = reason
        self.code = code


class ConflictError(Exception):
    status = 409

    def __init__(self, reason: str, code: str = "CONFLICT"):
        super().__init__(reason)
        self.reason = reason
        self.code = code


@dataclass(frozen=True)
class User:
    id: int
    username: str
    display_name: str
    role: Role

    def as_dict(self):
        return {"id": self.id, "username": self.username, "display_name": self.display_name,
                "role": self.role.value, "role_label": ROLE_LABEL[self.role],
                "permissions": sorted(PERMISSIONS[self.role])}


def has_perm(user: Optional[User], perm: str) -> bool:
    return user is not None and perm in PERMISSIONS.get(user.role, frozenset())


def require(user: Optional[User], perm: str) -> None:
    if user is None:
        raise AuthorizationError("인증되지 않은 요청", "UNAUTHENTICATED")
    if not has_perm(user, perm):
        raise AuthorizationError(f"{ROLE_LABEL[user.role]}({user.role.value}) 역할에는 '{perm}' 권한이 없습니다",
                                 "ROLE_DENIED")


@dataclass
class LockState:
    holder_id: Optional[int] = None
    holder_name: Optional[str] = None
    holder_role: Optional[str] = None
    acquired_at: Optional[float] = None

    def as_dict(self):
        return dict(self.__dict__)


class ControlLock:
    """단일 제어권. persist 콜백으로 DB에 저장해 재기동 후에도 유지된다."""

    def __init__(self, initial: LockState | None = None,
                 persist: Callable[[LockState], None] | None = None):
        self._state = initial or LockState()
        self._persist = persist or (lambda s: None)
        self._mu = threading.Lock()

    @property
    def state(self) -> LockState:
        with self._mu:
            return LockState(**self._state.__dict__)

    def holder(self) -> Optional[int]:
        return self._state.holder_id

    def acquire(self, user: User, force: bool = False) -> LockState:
        require(user, "control.acquire")
        with self._mu:
            cur = self._state
            if cur.holder_id not in (None, user.id):
                if not force:
                    raise ConflictError(f"제어권은 {cur.holder_name}({cur.holder_role})이 보유 중입니다. "
                                        "이양을 요청하거나 임무통제관 강제 인수가 필요합니다", "LOCK_HELD")
                if not has_perm(user, "control.force"):
                    raise AuthorizationError("강제 인수 권한(control.force)이 없습니다", "FORCE_DENIED")
            self._state = LockState(user.id, user.display_name, user.role.value, time.time())
            self._persist(self._state)
            return LockState(**self._state.__dict__)

    def release(self, user: User, *, admin: bool = False) -> LockState:
        with self._mu:
            if self._state.holder_id is None:
                return LockState()
            if self._state.holder_id != user.id and not (admin and has_perm(user, "control.force")):
                raise AuthorizationError("제어권 보유자만 이양(해제)할 수 있습니다", "NOT_HOLDER")
            self._state = LockState()
            self._persist(self._state)
            return LockState()

    def authorize_command(self, user: Optional[User], command: str) -> None:
        """비행 제어 명령 실행 가능 여부. 불가 시 AuthorizationError."""
        command = command.upper()
        if command not in FLIGHT_COMMANDS:
            raise AuthorizationError(f"알 수 없는 명령 '{command}'", "UNKNOWN_COMMAND")
        require(user, f"cmd.{command}")
        if self._state.holder_id != user.id:
            who = self._state.holder_name or "없음"
            raise AuthorizationError(f"제어권 미보유 — 현재 보유자: {who}", "NO_CONTROL")
