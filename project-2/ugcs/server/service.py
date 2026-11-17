"""지상통제 핵심 서비스 — 계층을 엮는 오케스트레이터.

  데이터링크(④) ──텔레메트리──▶ GNSS 파싱(④) ──▶ 경보 룰엔진(②) ──▶ DB(③)
        ▲                                                         │
        └── 명령/임무 업로드 ◀── 권한·제어권 검증(②) ◀── API(⑤) ◀─┘ SSE 방송 → 콘솔(①)
"""
from __future__ import annotations

import json
import queue
import threading
import time
from typing import Any, Optional

from .. import __version__, config
from ..data.db import DEFAULT_GCS, Database
from ..geo import destination, haversine
from ..integration.datalink import DataLinkAdapter, LinkTimeout, SimulatedDataLink
from ..integration.gnss import AircraftGnssReceiver, GnssSource, SimulatedVehicleGnss, relative
from ..integration.simulator import VehicleSimulator
from ..processing.alerts import CRITICAL, RuleEngine
from ..processing.mission import plan_mission
from ..processing.rbac import (DANGEROUS_COMMANDS, AuthorizationError, ConflictError, ControlLock,
                               LockState, Role, User, require)


class LinkError(Exception):
    status = 504

    def __init__(self, reason: str, code: str = "LINK_TIMEOUT"):
        super().__init__(reason)
        self.reason, self.code = reason, code


class ConfirmRequired(Exception):
    status = 428

    def __init__(self, reason: str, code: str = "CONFIRM_REQUIRED"):
        super().__init__(reason)
        self.reason, self.code = reason, code


def to_user(d: Optional[dict]) -> Optional[User]:
    if not d:
        return None
    return User(id=d["id"], username=d["username"], display_name=d["display_name"], role=Role(d["role"]))


class GroundControlService:
    def __init__(self, db: Database, *, link: Optional[DataLinkAdapter] = None,
                 gcs_gnss: Optional[GnssSource] = None, aircraft_id: str = "UAV-01"):
        self.db = db
        self.started = time.time()
        self.comm_radius_m = config.LIMITS["max_range_m"]
        self.gcs_gnss = gcs_gnss or SimulatedVehicleGnss(DEFAULT_GCS["lat"], DEFAULT_GCS["lon"])
        self.gcs_fix = self.gcs_gnss.read()
        # 기체는 통제차량 북동쪽 25 m 이착륙 패드에서 시작
        pad = destination(DEFAULT_GCS["lat"], DEFAULT_GCS["lon"], 45, 25)
        self.sim: Optional[VehicleSimulator] = None
        if link is None:
            self.sim = VehicleSimulator(*pad)
            link = SimulatedDataLink(self.sim, gcs_position=self._gcs_pos, comm_radius_m=self.comm_radius_m)
        self.link = link
        self.link.on_telemetry(self._on_telemetry)
        self.receiver = AircraftGnssReceiver()
        self.engine = RuleEngine()
        lk = db.load_lock()
        self.lock = ControlLock(LockState(lk.get("holder_id"), lk.get("holder_name"), lk.get("holder_role"),
                                          lk.get("acquired_at")),
                                persist=lambda s: db.save_lock(s.holder_id, s.acquired_at))
        self.aircraft_id = aircraft_id
        self.active_mission_id: Optional[int] = None
        self.telemetry: dict = {}
        self._telem_at: Optional[float] = None
        self._alert_ids: dict[str, int] = {}
        self.flight: Optional[dict] = None
        self._last_record = 0.0
        self._subs: set[queue.Queue] = set()
        self._subs_mu = threading.Lock()
        self._mu = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._tick_n = 0
        db.close_stale_alerts()
        stale = db.open_flight()
        if stale:   # 전원 재투입 등으로 종료되지 않은 비행 세션 마감
            db.end_flight(stale["id"], distance_m=stale["distance_m"], max_alt_m=stale["max_alt_m"],
                          reason="서버 재기동으로 세션 종료")

    # ---- 생명주기 --------------------------------------------------------
    def start(self):
        self.link.start()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="gcs-loop", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.link.stop()
        self.gcs_gnss.close()

    def _gcs_pos(self) -> Optional[dict]:
        f = self.gcs_fix
        return {"lat": f.lat, "lon": f.lon} if f else None

    # ---- 수신 처리 -------------------------------------------------------
    def _on_telemetry(self, t: dict):
        fix = self.receiver.ingest(t)
        with self._mu:
            self._telem_at = time.monotonic()
            self.telemetry = {
                "lat": fix.lat if fix else None, "lon": fix.lon if fix else None,
                "alt_msl": fix.alt_msl if fix else None,
                "gps": {"fix": fix.fix if fix else 0, "sats": fix.sats if fix else 0, "hdop": fix.hdop if fix else 99},
                **{k: t.get(k) for k in ("alt_rel", "heading", "groundspeed", "vspeed", "roll", "pitch", "battery_pct",
                                         "battery_v", "current_a", "armed", "mode", "failsafe", "wp_index", "wp_total",
                                         "mission_leg", "home", "gimbal")},
            }

    # ---- 주기 루프 -------------------------------------------------------
    def _loop(self):
        period = 1.0 / config.LOOP_HZ
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                import traceback
                traceback.print_exc()
            self._stop.wait(period)

    def tick(self):
        self._tick_n += 1
        if self._tick_n % int(config.LOOP_HZ) == 1:
            self.gcs_fix = self.gcs_gnss.read() or self.gcs_fix
        with self._mu:
            tel = dict(self.telemetry)
        link = self.link.stats()
        snap = {
            "link": link,
            "pos": {"lat": tel["lat"], "lon": tel["lon"], "alt": tel.get("alt_rel") or 0.0} if tel.get("lat") else None,
            "battery_pct": tel.get("battery_pct"),
            "gps": tel.get("gps"),
            "armed": bool(tel.get("armed")),
            "mode": tel.get("mode"),
            "mission_leg": tel.get("mission_leg"),
        }
        events = self.engine.evaluate(snap, self.alert_context())
        self._session(tel)
        for ev in events:
            self._persist_event(ev)
        if events:
            self.broadcast("alert", {"events": [e.as_dict() for e in events]})
        self.broadcast("state", self.state())

    def alert_context(self) -> dict:
        fence = None
        if self.active_mission_id:
            try:
                fence = self.db.get_mission(self.active_mission_id).get("geofence")
            except Exception:
                fence = None
        return {"nfz": self.db.nfz(), "geofence": fence or self.db.default_geofence(),
                "gcs": self._gcs_pos(), "comm_radius_m": self.comm_radius_m}

    def _persist_event(self, ev, latched: bool = False):
        fid = self.flight["id"] if self.flight else None
        if ev.type == "RAISE":
            self._alert_ids[ev.code] = self.db.raise_alert(code=ev.code, severity=ev.severity, message=ev.message,
                                                           cause=ev.cause, flight_id=fid, latched=latched)
        else:
            self.db.clear_alert_code(ev.code)
            self._alert_ids.pop(ev.code, None)

    def _session(self, tel: dict):
        """비행 세션: 시동(armed) 시작 ~ 착륙 후 시동 해제 종료, 1 Hz 텔레메트리 기록."""
        armed = bool(tel.get("armed"))
        now = time.time()
        if armed and self.flight is None:
            fid = self.db.start_flight(self.aircraft_id, self.active_mission_id, self.lock.holder())
            self.flight = {"id": fid, "started_at": now, "distance_m": 0.0, "max_alt_m": 0.0, "last": None}
            self.broadcast("flight", {"started": fid})
        if self.flight is None:
            return
        if tel.get("lat") is not None:
            last = self.flight["last"]
            if last:
                self.flight["distance_m"] += haversine(last[0], last[1], tel["lat"], tel["lon"])
            self.flight["last"] = (tel["lat"], tel["lon"])
            self.flight["max_alt_m"] = max(self.flight["max_alt_m"], tel.get("alt_rel") or 0.0)
        if now - self._last_record >= 1.0 / config.TELEMETRY_RECORD_HZ and tel.get("lat") is not None:
            self._last_record = now
            rec = {k: tel.get(k) for k in ("lat", "lon", "alt_rel", "heading", "groundspeed", "vspeed", "roll", "pitch",
                                           "battery_pct", "mode", "armed", "wp_index", "gps", "gimbal")}
            rec["link"] = {k: self.link.stats().get(k) for k in ("connected", "latency_ms", "loss_pct", "rssi_dbm")}
            self.db.add_telemetry(self.flight["id"], now, rec)
        if not armed and tel.get("mode") == "LANDED":
            f = self.flight
            self.db.end_flight(f["id"], distance_m=f["distance_m"], max_alt_m=f["max_alt_m"],
                               reason=tel.get("failsafe") or "정상 착륙")
            self.flight = None
            self.broadcast("flight", {"ended": f["id"]})

    # ---- 상태 스냅샷 -----------------------------------------------------
    def state(self) -> dict:
        with self._mu:
            tel = dict(self.telemetry)
            age = None if self._telem_at is None else round(time.monotonic() - self._telem_at, 2)
        ac = self.db.get_aircraft(self.aircraft_id)
        ac_pos = {"lat": tel["lat"], "lon": tel["lon"]} if tel.get("lat") is not None else None
        return {
            "server_time": time.time(),
            "aircraft": ac,
            "telemetry": {**tel, "age_s": age},
            "link": self.link.stats(),
            "gcs": self.gcs_fix.as_dict() if self.gcs_fix else None,
            "relative": relative(self._gcs_pos(), ac_pos, self.comm_radius_m),
            "comm_radius_m": self.comm_radius_m,
            "control": self.lock.state.as_dict(),
            "alerts_active": self.db.list_alerts(active_only=True, limit=50),
            "flight": ({"id": self.flight["id"], "elapsed_s": round(time.time() - self.flight["started_at"], 1),
                        "distance_m": round(self.flight["distance_m"], 1)} if self.flight else None),
            "active_mission_id": self.active_mission_id,
            "sim": self.sim_state(),
        }

    def health(self) -> dict:
        db = self.db.health()
        link = self.link.stats()
        loop_ok = self._thread is not None and self._thread.is_alive()
        return {"status": "ok" if db["ok"] and loop_ok else "degraded", "version": __version__,
                "uptime_s": round(time.time() - self.started, 1), "db": db,
                "datalink": {"adapter": link.get("adapter"), "connected": link.get("connected"),
                             "hb_age_s": link.get("hb_age_s")},
                "loop_running": loop_ok, "network": "local-only"}

    # ---- SSE 방송 --------------------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=20)
        with self._subs_mu:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self._subs_mu:
            self._subs.discard(q)

    def broadcast(self, event: str, data: Any):
        msg = (event, json.dumps(data, ensure_ascii=False, default=str))
        with self._subs_mu:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(msg)
            except queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except (queue.Empty, queue.Full):
                    pass

    # ---- 제어권 --------------------------------------------------------
    def acquire_control(self, user: User, force: bool = False) -> dict:
        prev = self.lock.state
        try:
            st = self.lock.acquire(user, force=force)
        except (AuthorizationError, ConflictError) as e:
            self.db.audit(user=user.as_dict(), action="CONTROL_ACQUIRE", target="control",
                          result="DENIED", detail={"reason": e.reason, "force": force})
            raise
        self.db.audit(user=user.as_dict(), action="CONTROL_FORCE" if force and prev.holder_id not in (None, user.id)
                      else "CONTROL_ACQUIRE", target="control", detail={"previous": prev.holder_name})
        self.broadcast("control", st.as_dict())
        return st.as_dict()

    def release_control(self, user: User, admin: bool = False) -> dict:
        prev = self.lock.state
        try:
            st = self.lock.release(user, admin=admin)
        except AuthorizationError as e:
            self.db.audit(user=user.as_dict(), action="CONTROL_RELEASE", target="control",
                          result="DENIED", detail={"reason": e.reason})
            raise
        self.db.audit(user=user.as_dict(), action="CONTROL_RELEASE", target="control",
                      detail={"previous": prev.holder_name})
        self.broadcast("control", st.as_dict())
        return st.as_dict()

    # ---- 비행 제어 명령 -------------------------------------------------
    def _deny(self, user: Optional[User], cmd: str, err, params: dict):
        self.db.audit(user=user.as_dict() if user else None, action=f"CMD_{cmd}", target=self.aircraft_id,
                      result="DENIED", detail={"reason": err.reason, "code": err.code, "params": params})

    def execute_command(self, user: Optional[User], command: str, params: dict | None = None) -> dict:
        cmd = (command or "").upper()
        params = dict(params or {})
        try:
            self.lock.authorize_command(user, cmd)            # 역할 + 제어권
        except AuthorizationError as e:
            self._deny(user, cmd, e, params)
            raise
        if cmd in DANGEROUS_COMMANDS and params.get("confirm") != DANGEROUS_COMMANDS[cmd]:
            err = ConfirmRequired(f"위험 명령 {cmd}은 2차 확인(confirm='{DANGEROUS_COMMANDS[cmd]}')이 필요합니다")
            self._deny(user, cmd, err, params)
            raise err
        tel = self.telemetry
        airborne = bool(tel.get("armed"))
        ac = self.db.get_aircraft(self.aircraft_id)
        if cmd in ("TAKEOFF", "START_MISSION") and not airborne and ac["status"] != "AIRWORTHY":
            ev = self.engine.raise_event("GROUNDED_TAKEOFF", CRITICAL, "정비 불가 기체 이륙/임무 시도 차단",
                                         f"{ac['id']}({ac['name']}) 상태 {ac['status']} — {user.display_name}의 {cmd} 요청 거부")
            self._persist_event(ev, latched=True)
            self.broadcast("alert", {"events": [ev.as_dict()]})
            err = ConflictError(f"{ac['id']} 기체 상태가 {ac['status']}이므로 이륙할 수 없습니다", "AIRCRAFT_NOT_AIRWORTHY")
            self._deny(user, cmd, err, params)
            raise err
        payload: dict = {}
        try:
            if cmd == "UPLOAD_MISSION":
                return self._upload_mission(user, params)
            if cmd == "TAKEOFF":
                alt = float(params.get("alt", 30))
                if not (config.LIMITS["min_alt_m"] <= alt <= config.LIMITS["max_alt_m"]):
                    err = ConflictError(f"이륙 고도는 {config.LIMITS['min_alt_m']:.0f}~{config.LIMITS['max_alt_m']:.0f} m", "BAD_ALT")
                    self._deny(user, cmd, err, params)
                    raise err
                payload = {"alt": alt}
            elif cmd == "START_MISSION":
                if not self.active_mission_id:
                    err = ConflictError("업로드된 임무가 없습니다. 먼저 임무를 업로드하세요", "NO_MISSION")
                    self._deny(user, cmd, err, params)
                    raise err
            elif cmd == "GIMBAL":
                payload = {k: float(params[k]) for k in ("pitch", "yaw") if k in params}
            ack = self.link.send_command(cmd, payload, timeout=0.8, retries=3)
        except LinkTimeout as e:
            self.db.audit(user=user.as_dict(), action=f"CMD_{cmd}", target=self.aircraft_id, result="ERROR",
                          detail={"reason": str(e), "params": params})
            raise LinkError(f"{cmd}: 데이터링크 응답 없음 — {e}")
        self.db.audit(user=user.as_dict(), action=f"CMD_{cmd}", target=self.aircraft_id,
                      result="ALLOWED" if ack.ok else "ERROR", detail={"ack": ack.as_dict(), "params": payload})
        if not ack.ok:
            raise ConflictError(f"기체가 명령을 거부: {ack.message}", "VEHICLE_DENIED")
        return {"command": cmd, "ack": ack.as_dict()}

    def _upload_mission(self, user: User, params: dict) -> dict:
        mid = int(params.get("mission_id", 0))
        m = self.db.get_mission(mid)
        if m["status"] not in ("READY", "UPLOADED"):
            err = ConflictError(f"READY 상태 임무만 업로드할 수 있습니다 (현재 {m['status']})", "MISSION_NOT_READY")
            self._deny(user, "UPLOAD_MISSION", err, params)
            raise err
        if m["aircraft_id"] != self.aircraft_id:
            err = ConflictError(f"임무 대상 기체({m['aircraft_id']})와 연결 기체({self.aircraft_id})가 다릅니다", "AIRCRAFT_MISMATCH")
            self._deny(user, "UPLOAD_MISSION", err, params)
            raise err
        plan = self.plan_for(m)
        if not plan["ok"]:
            err = ConflictError("경로 검증 실패 — " + "; ".join(i["message"] for i in plan["issues"] if i["severity"] == "ERROR"),
                                "PLAN_INVALID")
            self._deny(user, "UPLOAD_MISSION", err, params)
            raise err
        items = [{k: w.get(k) for k in ("lat", "lon", "alt", "speed", "hold", "action")} for w in m["waypoints"]]
        try:
            ack = self.link.upload_mission(items, timeout=1.5, retries=3)
        except LinkTimeout as e:
            self.db.audit(user=user.as_dict(), action="CMD_UPLOAD_MISSION", target=f"mission:{mid}", result="ERROR",
                          detail={"reason": str(e)})
            raise LinkError(f"임무 업로드 실패: {e}")
        self.db.audit(user=user.as_dict(), action="CMD_UPLOAD_MISSION", target=f"mission:{mid}",
                      result="ALLOWED" if ack.ok else "ERROR", detail={"ack": ack.as_dict(), "version": m["version"]})
        if not ack.ok:
            raise ConflictError(f"기체가 임무를 거부: {ack.message}", "VEHICLE_DENIED")
        for other in self.db.list_missions():
            if other["status"] == "UPLOADED" and other["id"] != mid:
                self.db.set_mission_status(other["id"], "READY", system=True)
        self.db.set_mission_status(mid, "UPLOADED", plan=plan, system=True)
        self.active_mission_id = mid
        return {"command": "UPLOAD_MISSION", "ack": ack.as_dict(), "mission_id": mid, "version": m["version"]}

    # ---- 임무 계획 -----------------------------------------------------
    def plan_for(self, mission: dict) -> dict:
        tel = self.telemetry
        start_batt = 100.0
        if mission["aircraft_id"] == self.aircraft_id and tel.get("battery_pct") is not None:
            start_batt = float(tel["battery_pct"])
        home = mission.get("home") or self._gcs_pos() or DEFAULT_GCS
        plan = plan_mission(home, mission["waypoints"], nfz=self.db.nfz(),
                            geofence=mission.get("geofence") or self.db.default_geofence(),
                            start_battery_pct=start_batt)
        return plan.as_dict()

    def validate_mission(self, user: User, mid: int) -> dict:
        m = self.db.get_mission(mid)
        plan = self.plan_for(m)
        self.db.save_plan(mid, plan)
        return plan

    def set_mission_status(self, user: User, mid: int, status: str) -> dict:
        status = status.upper()
        if status == "READY":
            require(user, "mission.approve")
            plan = self.plan_for(self.db.get_mission(mid))
            if not plan["ok"]:
                raise ConflictError("검증 오류가 있어 READY로 승인할 수 없습니다", "PLAN_INVALID")
            m = self.db.set_mission_status(mid, "READY", plan=plan)
        elif status == "ARCHIVED":
            require(user, "mission.archive")
            m = self.db.set_mission_status(mid, "ARCHIVED")
        elif status == "UPLOADED":
            raise ConflictError("UPLOADED 상태는 업로드 명령으로만 설정됩니다", "BAD_TRANSITION")
        else:
            require(user, "mission.write")
            m = self.db.set_mission_status(mid, status)
        if self.active_mission_id == mid and status != "UPLOADED":
            self.active_mission_id = None
        return m

    # ---- 시뮬레이터 제어 ----------------------------------------------
    def sim_state(self) -> Optional[dict]:
        if not isinstance(self.link, SimulatedDataLink) or not self.sim:
            return None
        f = self.sim.faults
        return {**self.link.faults(), "battery_drain_x": f.battery_drain_x, "wind_mps": f.wind_mps,
                "gps_degraded": f.gps_degraded}

    def sim_control(self, user: User, body: dict) -> dict:
        require(user, "sim.control")
        if not isinstance(self.link, SimulatedDataLink) or not self.sim:
            raise ConflictError("시뮬레이터 모드가 아닙니다", "NOT_SIM")
        action = body.get("action", "faults")
        if action == "reset":
            if self.telemetry.get("armed"):
                raise ConflictError("비행 중에는 초기화할 수 없습니다", "AIRBORNE")
            pad = destination(self.gcs_fix.lat, self.gcs_fix.lon, 45, 25) if self.gcs_fix else None
            self.sim.reset(*(pad or (None, None)))
            self.link.set_faults(link_down=False, latency_ms=25, loss_pct=0, corrupt_pct=0)
        elif action == "battery_drop":
            self.sim.battery_drop(float(body.get("pct", 20)))
        elif action == "move_gcs":
            if isinstance(self.gcs_gnss, SimulatedVehicleGnss):
                self.gcs_gnss.move_to(float(body["lat"]), float(body["lon"]))
                self.gcs_fix = self.gcs_gnss.read()
        else:
            self.link.set_faults(link_down=body.get("link_down"), latency_ms=body.get("latency_ms"),
                                 loss_pct=body.get("loss_pct"), corrupt_pct=body.get("corrupt_pct"))
            f = self.sim.faults
            if "battery_drain_x" in body:
                f.battery_drain_x = max(0.1, min(50.0, float(body["battery_drain_x"])))
            if "wind_mps" in body:
                f.wind_mps = max(0.0, min(20.0, float(body["wind_mps"])))
            if "gps_degraded" in body:
                f.gps_degraded = bool(body["gps_degraded"])
        self.db.audit(user=user.as_dict(), action=f"SIM_{action.upper()}", target="simulator", detail=body)
        return self.sim_state()

    def ack_alert(self, user: User, alert_id: int) -> dict:
        require(user, "alert.ack")
        a = self.db.ack_alert(alert_id, user.id)
        if a["latched"]:
            self.engine.clear_latched(a["code"])
        self.db.audit(user=user.as_dict(), action="ALERT_ACK", target=f"alert:{alert_id}", detail={"code": a["code"]})
        self.broadcast("alert", {"ack": alert_id})
        return a

    def select_aircraft(self, user: User, aircraft_id: str) -> dict:
        require(user, "control.acquire")
        if self.lock.holder() != user.id:
            raise AuthorizationError("제어권 보유자만 연결 기체를 변경할 수 있습니다", "NO_CONTROL")
        if self.telemetry.get("armed"):
            raise ConflictError("비행 중에는 기체를 변경할 수 없습니다", "AIRBORNE")
        ac = self.db.get_aircraft(aircraft_id)
        self.aircraft_id = aircraft_id
        self.active_mission_id = None
        self.db.audit(user=user.as_dict(), action="AIRCRAFT_SELECT", target=aircraft_id)
        return ac
