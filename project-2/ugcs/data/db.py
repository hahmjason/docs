"""SQLite 영속 계층 + 저장소(Repository) 메서드.

- 단일 파일 DB, WAL 저널 + synchronous=NORMAL → 전원 차단 시에도 커밋된 트랜잭션 보존
- 스레드 간 공유 연결 1개를 RLock으로 직렬화 (차량 탑재 서버 규모에 충분)
- 최초 기동 시 기본 운용자/기체/공역/예시 임무를 시드한다
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable, Optional

from ..geo import LocalProjection

SCHEMA = (Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8")
SCHEMA_VERSION = "1"

MISSION_STATUSES = ("DRAFT", "READY", "UPLOADED", "ARCHIVED")
AIRCRAFT_STATUSES = ("AIRWORTHY", "MAINTENANCE_REQUIRED", "GROUNDED")
MAINT_TYPES = ("정기점검", "수리", "부품교체")
# 수동 상태 전이 (UPLOADED는 업로드 명령 ACK로만 진입)
MISSION_TRANSITIONS = {
    "DRAFT": {"READY", "ARCHIVED"},
    "READY": {"DRAFT", "ARCHIVED"},
    "UPLOADED": {"DRAFT", "ARCHIVED"},
    "ARCHIVED": {"DRAFT"},
}

# 기본 운용자 (개발/훈련용 PIN — 운용 전 변경 필수)
DEFAULT_USERS = [
    ("pilot1", "김조종 (조종사)", "PILOT", "1111"),
    ("pilot2", "이조종 (조종사)", "PILOT", "1112"),
    ("mc1", "박통제 (임무통제관)", "MISSION_CTRL", "2222"),
    ("maint1", "최정비 (정비사)", "MAINTENANCE", "3333"),
    ("obs1", "정관찰 (관찰자)", "OBSERVER", "4444"),
]

# 가상 훈련장 기준점 = 통제차량 초기 위치
DEFAULT_GCS = {"lat": 36.1400, "lon": 128.3900}


def hash_pin(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), 120_000).hex()


class NotFound(Exception):
    status = 404


class Conflict(Exception):
    status = 409


def _j(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


class Database:
    def __init__(self, path: str | os.PathLike = ":memory:", *, seed: bool = True):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._mu = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        if self.path != ":memory:":
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        if seed and self._meta("seeded") is None:
            self._seed()

    # ---- 기본 ------------------------------------------------------------
    def close(self):
        with self._mu:
            self.conn.close()

    def q(self, sql: str, args: Iterable = ()) -> list[dict]:
        with self._mu:
            return [dict(r) for r in self.conn.execute(sql, tuple(args)).fetchall()]

    def q1(self, sql: str, args: Iterable = ()) -> Optional[dict]:
        rows = self.q(sql, args)
        return rows[0] if rows else None

    def x(self, sql: str, args: Iterable = ()) -> int:
        with self._mu:
            cur = self.conn.execute(sql, tuple(args))
            return cur.lastrowid

    def tx(self):
        """with db.tx(): ... — 다중 쓰기 원자성."""
        db = self

        class _Tx:
            def __enter__(self_):
                db._mu.acquire()
                db.conn.execute("BEGIN IMMEDIATE")

            def __exit__(self_, et, ev, tb):
                try:
                    db.conn.execute("ROLLBACK" if et else "COMMIT")
                finally:
                    db._mu.release()
        return _Tx()

    def _meta(self, key: str) -> Optional[str]:
        r = self.q1("SELECT value FROM meta WHERE key=?", (key,))
        return r["value"] if r else None

    def health(self) -> dict:
        with self._mu:
            ok = self.conn.execute("PRAGMA quick_check").fetchone()[0]
        return {"ok": ok == "ok", "path": self.path, "schema": self._meta("schema_version")}

    # ---- 시드 --------------------------------------------------------------
    def _seed(self):
        now = time.time()
        proj = LocalProjection(DEFAULT_GCS["lat"], DEFAULT_GCS["lon"])

        def ring(pts_m):
            return [[round(c, 6) for c in proj.to_ll(x, y)] for x, y in pts_m]

        with self.tx():
            for u, name, role, pin in DEFAULT_USERS:
                salt = secrets.token_hex(16)
                self.conn.execute("INSERT INTO users(username,display_name,role,pin_hash,salt) VALUES(?,?,?,?,?)",
                                  (u, name, role, hash_pin(pin, salt), salt))
            self.conn.execute("INSERT INTO control_lock(id) VALUES(1)")
            for ac in (("UAV-01", "송골매-1", "VTOL 쿼드 QX-4", "AIRWORTHY"),
                       ("UAV-02", "송골매-2", "VTOL 쿼드 QX-4", "GROUNDED"),
                       ("UAV-03", "수리부엉이-1", "고정익 FW-2", "MAINTENANCE_REQUIRED")):
                self.conn.execute("INSERT INTO aircraft(id,name,model,status,updated_at) VALUES(?,?,?,?,?)",
                                  (*ac, now))
            zones = [
                ("GEOFENCE", "훈련장 비행 허용구역",
                 ring([(-3800, -3000), (3600, -3400), (4200, 2600), (800, 4300), (-3600, 3200)]), {}),
                ("NFZ", "탄약고 보호구역",
                 ring([(900, 1300), (1700, 1200), (1850, 2000), (1050, 2150)]), {"floor": 0, "ceiling": 9999}),
                ("NFZ", "민가 밀집지역",
                 ring([(-2600, -1900), (-1500, -2100), (-1300, -1200), (-2300, -900)]), {"floor": 0, "ceiling": 9999}),
                ("NFZ", "송전선로 회랑",
                 ring([(2300, -2600), (2600, -2600), (2600, 400), (2300, 400)]), {"floor": 0, "ceiling": 9999}),
                ("TERRAIN", "매봉산", ring([(-1500, 1500), (-700, 1300), (-500, 2200), (-1100, 2700), (-1700, 2300)]),
                 {"type": "hill", "elev": 380}),
                ("TERRAIN", "서산 능선", ring([(2800, 1200), (3600, 900), (3900, 1800), (3100, 2100)]),
                 {"type": "hill", "elev": 245}),
                ("TERRAIN", "낙동강 지류", ring([(-3800, -400), (-2000, -250), (-600, -700), (600, -500),
                                              (1900, -1100), (3400, -900), (4200, -1300)]), {"type": "river"}),
                ("TERRAIN", "저수지", ring([(-400, 2600), (300, 2500), (500, 3100), (-200, 3300), (-600, 3000)]),
                 {"type": "water"}),
                ("TERRAIN", "보급로 1호", ring([(-3600, 600), (-1200, 300), (0, 0), (1500, 400), (4000, 300)]),
                 {"type": "road"}),
                ("TERRAIN", "보급로 2호", ring([(0, 0), (-200, -1500), (300, -3200)]), {"type": "road"}),
            ]
            for kind, name, geom, props in zones:
                self.conn.execute("INSERT INTO zones(kind,name,geometry,props) VALUES(?,?,?,?)",
                                  (kind, name, _j(geom), _j(props)))
            wps = [{"lat": round(ll[0], 6), "lon": round(ll[1], 6), "alt": alt, "speed": 10, "hold": hold, "action": act}
                   for ll, alt, hold, act in [
                       (proj.to_ll(300, 600), 60, 0, "WAYPOINT"),
                       (proj.to_ll(-300, 1100), 80, 20, "PHOTO"),
                       (proj.to_ll(-800, 500), 80, 30, "LOITER"),
                       (proj.to_ll(-500, -300), 60, 0, "WAYPOINT")]]
            self.conn.execute(
                "INSERT INTO missions(name,aircraft_id,waypoints,home,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                ("기지 주변 정찰 (예시)", "UAV-01", _j(wps), _j(DEFAULT_GCS), "DRAFT", now, now))
            self.conn.execute("INSERT INTO maintenance(aircraft_id,date,technician,mtype,checklist,notes,result_status,created_at)"
                              " VALUES(?,?,?,?,?,?,?,?)",
                              ("UAV-02", time.strftime("%Y-%m-%d"), "최정비", "수리",
                               _j([{"item": "모터 #3 진동", "ok": False}, {"item": "프로펠러 균열", "ok": False},
                                   {"item": "배터리 셀 전압", "ok": True}]),
                               "3번 모터 베어링 손상 — 부품 입고 대기", "GROUNDED", now))
            self.conn.execute("INSERT INTO meta(key,value) VALUES('seeded','1'),('schema_version',?)", (SCHEMA_VERSION,))

    # ---- 사용자/세션 ------------------------------------------------------
    def list_users(self) -> list[dict]:
        return self.q("SELECT id,username,display_name,role FROM users WHERE active=1 ORDER BY id")

    def get_user(self, user_id: int) -> Optional[dict]:
        return self.q1("SELECT id,username,display_name,role FROM users WHERE id=?", (user_id,))

    def verify_login(self, username: str, pin: str) -> Optional[dict]:
        r = self.q1("SELECT * FROM users WHERE username=? AND active=1", (username,))
        if not r or not hmac.compare_digest(r["pin_hash"], hash_pin(str(pin), r["salt"])):
            return None
        return {k: r[k] for k in ("id", "username", "display_name", "role")}

    def create_session(self, user_id: int, ttl_s: float) -> str:
        tok = secrets.token_urlsafe(32)
        now = time.time()
        self.x("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)",
               (tok, user_id, now, now + ttl_s))
        self.x("DELETE FROM sessions WHERE expires_at < ?", (now,))
        return tok

    def session_user(self, token: str) -> Optional[dict]:
        if not token:
            return None
        return self.q1("SELECT u.id,u.username,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id "
                       "WHERE s.token=? AND s.expires_at > ? AND u.active=1", (token, time.time()))

    def delete_session(self, token: str):
        self.x("DELETE FROM sessions WHERE token=?", (token,))

    # ---- 제어권 ------------------------------------------------------------
    def load_lock(self) -> dict:
        return self.q1("SELECT l.holder_id, l.acquired_at, u.display_name AS holder_name, u.role AS holder_role "
                       "FROM control_lock l LEFT JOIN users u ON u.id=l.holder_id WHERE l.id=1") or {}

    def save_lock(self, holder_id: Optional[int], acquired_at: Optional[float]):
        self.x("UPDATE control_lock SET holder_id=?, acquired_at=? WHERE id=1", (holder_id, acquired_at))

    # ---- 기체 --------------------------------------------------------------
    def list_aircraft(self) -> list[dict]:
        return self.q("SELECT * FROM aircraft ORDER BY id")

    def get_aircraft(self, aid: str) -> dict:
        r = self.q1("SELECT * FROM aircraft WHERE id=?", (aid,))
        if not r:
            raise NotFound(f"기체 {aid} 없음")
        return r

    def set_aircraft_status(self, aid: str, status: str):
        if status not in AIRCRAFT_STATUSES:
            raise ValueError(f"잘못된 기체 상태 {status}")
        self.get_aircraft(aid)
        self.x("UPDATE aircraft SET status=?, updated_at=? WHERE id=?", (status, time.time(), aid))

    def add_flight_time(self, aid: str, seconds: float):
        self.x("UPDATE aircraft SET total_flight_s = total_flight_s + ? WHERE id=?", (seconds, aid))

    # ---- 공역 ------------------------------------------------------------
    def list_zones(self) -> list[dict]:
        rows = self.q("SELECT * FROM zones ORDER BY id")
        for r in rows:
            r["geometry"] = json.loads(r["geometry"])
            r["props"] = json.loads(r["props"])
        return rows

    def nfz(self) -> list[dict]:
        return [{"name": z["name"], "polygon": z["geometry"]} for z in self.list_zones() if z["kind"] == "NFZ"]

    def default_geofence(self) -> Optional[list]:
        for z in self.list_zones():
            if z["kind"] == "GEOFENCE":
                return z["geometry"]
        return None

    # ---- 임무 계획 -------------------------------------------------------
    @staticmethod
    def _mission_row(r: dict) -> dict:
        for k in ("waypoints", "geofence", "home", "last_plan"):
            r[k] = json.loads(r[k]) if r.get(k) else None
        return r

    def list_missions(self, include_archived: bool = True) -> list[dict]:
        sql = "SELECT * FROM missions" + ("" if include_archived else " WHERE status!='ARCHIVED'") + " ORDER BY updated_at DESC"
        return [self._mission_row(r) for r in self.q(sql)]

    def get_mission(self, mid: int) -> dict:
        r = self.q1("SELECT * FROM missions WHERE id=?", (mid,))
        if not r:
            raise NotFound(f"임무 {mid} 없음")
        return self._mission_row(r)

    def create_mission(self, *, name: str, aircraft_id: str, waypoints: list, geofence=None,
                       home=None, created_by: Optional[int] = None) -> dict:
        if not name or not str(name).strip():
            raise ValueError("임무명을 입력하세요")
        self.get_aircraft(aircraft_id)
        now = time.time()
        mid = self.x("INSERT INTO missions(name,aircraft_id,waypoints,geofence,home,status,created_by,created_at,updated_at)"
                     " VALUES(?,?,?,?,?,'DRAFT',?,?,?)",
                     (name.strip(), aircraft_id, _j(waypoints or []), _j(geofence) if geofence else None,
                      _j(home or DEFAULT_GCS), created_by, now, now))
        return self.get_mission(mid)

    def update_mission(self, mid: int, **fields) -> dict:
        m = self.get_mission(mid)
        if m["status"] == "ARCHIVED":
            raise Conflict("보관된 임무는 수정할 수 없습니다 (DRAFT로 복원 후 수정)")
        sets, args = [], []
        for k in ("name", "aircraft_id", "waypoints", "geofence", "home"):
            if k in fields and fields[k] is not None:
                v = fields[k]
                if k == "aircraft_id":
                    self.get_aircraft(v)
                sets.append(f"{k}=?")
                args.append(_j(v) if k in ("waypoints", "geofence", "home") else v)
        if not sets:
            return m
        # 내용이 바뀌면 버전 증가 + DRAFT로 되돌림(재검증 필요)
        sets += ["version=version+1", "status='DRAFT'", "last_plan=NULL", "updated_at=?"]
        args += [time.time(), mid]
        self.x(f"UPDATE missions SET {', '.join(sets)} WHERE id=?", args)
        return self.get_mission(mid)

    def set_mission_status(self, mid: int, status: str, *, plan: Optional[dict] = None, system: bool = False) -> dict:
        m = self.get_mission(mid)
        if status not in MISSION_STATUSES:
            raise ValueError(f"잘못된 임무 상태 {status}")
        if not system and status not in MISSION_TRANSITIONS[m["status"]]:
            raise Conflict(f"{m['status']} → {status} 전이는 허용되지 않습니다")
        self.x("UPDATE missions SET status=?, last_plan=COALESCE(?, last_plan), updated_at=? WHERE id=?",
               (status, _j(plan) if plan else None, time.time(), mid))
        return self.get_mission(mid)

    def save_plan(self, mid: int, plan: dict):
        self.x("UPDATE missions SET last_plan=? WHERE id=?", (_j(plan), mid))

    def delete_mission(self, mid: int):
        m = self.get_mission(mid)
        if m["status"] == "UPLOADED":
            raise Conflict("업로드된 임무는 삭제할 수 없습니다 (보관 처리하세요)")
        if self.q1("SELECT 1 FROM flights WHERE mission_id=? LIMIT 1", (mid,)):
            raise Conflict("비행 기록이 있는 임무는 삭제할 수 없습니다 (보관 처리하세요)")
        self.x("DELETE FROM missions WHERE id=?", (mid,))

    # ---- 비행 기록 / 텔레메트리 ------------------------------------------
    def start_flight(self, aircraft_id: str, mission_id: Optional[int], operator_id: Optional[int]) -> int:
        return self.x("INSERT INTO flights(aircraft_id,mission_id,operator_id,started_at) VALUES(?,?,?,?)",
                      (aircraft_id, mission_id, operator_id, time.time()))

    def end_flight(self, fid: int, *, distance_m: float, max_alt_m: float, reason: str):
        f = self.get_flight(fid)
        now = time.time()
        self.x("UPDATE flights SET ended_at=?, distance_m=?, max_alt_m=?, end_reason=? WHERE id=?",
               (now, distance_m, max_alt_m, reason, fid))
        self.add_flight_time(f["aircraft_id"], now - f["started_at"])

    def get_flight(self, fid: int) -> dict:
        r = self.q1("SELECT f.*, u.display_name AS operator, m.name AS mission_name FROM flights f "
                    "LEFT JOIN users u ON u.id=f.operator_id LEFT JOIN missions m ON m.id=f.mission_id WHERE f.id=?", (fid,))
        if not r:
            raise NotFound(f"비행 기록 {fid} 없음")
        r["samples"] = self.q1("SELECT COUNT(*) AS n FROM telemetry WHERE flight_id=?", (fid,))["n"]
        return r

    def list_flights(self, limit: int = 50) -> list[dict]:
        return self.q("SELECT f.*, u.display_name AS operator, m.name AS mission_name, "
                      "(SELECT COUNT(*) FROM telemetry t WHERE t.flight_id=f.id) AS samples, "
                      "(SELECT COUNT(*) FROM alerts a WHERE a.flight_id=f.id) AS alert_count "
                      "FROM flights f LEFT JOIN users u ON u.id=f.operator_id "
                      "LEFT JOIN missions m ON m.id=f.mission_id ORDER BY f.id DESC LIMIT ?", (limit,))

    def add_telemetry(self, fid: int, t: float, data: dict):
        self.x("INSERT INTO telemetry(flight_id,t,data) VALUES(?,?,?)", (fid, t, _j(data)))

    def flight_telemetry(self, fid: int) -> list[dict]:
        self.get_flight(fid)
        return [{"t": r["t"], **json.loads(r["data"])}
                for r in self.q("SELECT t,data FROM telemetry WHERE flight_id=? ORDER BY t", (fid,))]

    def open_flight(self) -> Optional[dict]:
        return self.q1("SELECT * FROM flights WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1")

    # ---- 경보 ------------------------------------------------------------
    def raise_alert(self, *, code, severity, message, cause, flight_id=None, latched=False) -> int:
        return self.x("INSERT INTO alerts(flight_id,code,severity,message,cause,raised_at,latched) VALUES(?,?,?,?,?,?,?)",
                      (flight_id, code, severity, message, cause, time.time(), int(latched)))

    def clear_alert_code(self, code: str):
        self.x("UPDATE alerts SET cleared_at=? WHERE code=? AND cleared_at IS NULL", (time.time(), code))

    def ack_alert(self, aid: int, user_id: int) -> dict:
        a = self.q1("SELECT * FROM alerts WHERE id=?", (aid,))
        if not a:
            raise NotFound(f"경보 {aid} 없음")
        now = time.time()
        if a["acked_at"] is None:
            self.x("UPDATE alerts SET acked_at=?, acked_by=? WHERE id=?", (now, user_id, aid))
        if a["latched"] and a["cleared_at"] is None:
            self.x("UPDATE alerts SET cleared_at=? WHERE id=?", (now, aid))
        return self.get_alert(aid)

    def get_alert(self, aid: int) -> dict:
        return self.q1("SELECT a.*, u.display_name AS acked_by_name FROM alerts a LEFT JOIN users u ON u.id=a.acked_by "
                       "WHERE a.id=?", (aid,))

    def list_alerts(self, *, active_only: bool = False, flight_id: Optional[int] = None, limit: int = 200) -> list[dict]:
        where, args = [], []
        if active_only:
            where.append("a.cleared_at IS NULL")
        if flight_id is not None:
            where.append("a.flight_id=?")
            args.append(flight_id)
        sql = ("SELECT a.*, u.display_name AS acked_by_name FROM alerts a LEFT JOIN users u ON u.id=a.acked_by"
               + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY a.id DESC LIMIT ?")
        return self.q(sql, args + [limit])

    def close_stale_alerts(self):
        """재기동 시 이전 실행의 조건형 경보 정리 (엔진이 다시 판단함)."""
        self.x("UPDATE alerts SET cleared_at=?, cause=cause || ' [서버 재기동으로 종료]' "
               "WHERE cleared_at IS NULL AND latched=0", (time.time(),))

    # ---- 정비 이력 -------------------------------------------------------
    def add_maintenance(self, *, aircraft_id: str, date: str, technician: str, mtype: str,
                        checklist: list, notes: str, result_status: str, created_by: Optional[int]) -> dict:
        if mtype not in MAINT_TYPES:
            raise ValueError(f"정비 유형은 {MAINT_TYPES} 중 하나여야 합니다")
        if result_status not in AIRCRAFT_STATUSES:
            raise ValueError("잘못된 기체 가용 상태")
        if not technician or not date:
            raise ValueError("작업자와 점검 일자는 필수입니다")
        self.get_aircraft(aircraft_id)
        with self.tx():
            cur = self.conn.execute(
                "INSERT INTO maintenance(aircraft_id,date,technician,mtype,checklist,notes,result_status,created_by,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (aircraft_id, date, technician, mtype, _j(checklist or []), notes or "", result_status, created_by, time.time()))
            # 정비 결과가 곧 기체 가용 상태 → 임무 투입 가능 여부에 즉시 연동
            self.conn.execute("UPDATE aircraft SET status=?, updated_at=? WHERE id=?", (result_status, time.time(), aircraft_id))
            mid = cur.lastrowid
        return self.get_maintenance(mid)

    def get_maintenance(self, mid: int) -> dict:
        r = self.q1("SELECT * FROM maintenance WHERE id=?", (mid,))
        if not r:
            raise NotFound(f"정비 기록 {mid} 없음")
        r["checklist"] = json.loads(r["checklist"])
        return r

    def list_maintenance(self, aircraft_id: Optional[str] = None) -> list[dict]:
        rows = self.q("SELECT * FROM maintenance" + (" WHERE aircraft_id=?" if aircraft_id else "") + " ORDER BY id DESC",
                      (aircraft_id,) if aircraft_id else ())
        for r in rows:
            r["checklist"] = json.loads(r["checklist"])
        return rows

    # ---- 감사 로그 -------------------------------------------------------
    def audit(self, *, user: Optional[dict], action: str, target: str = "", result: str = "ALLOWED",
              detail: Optional[dict] = None) -> int:
        return self.x("INSERT INTO audit(t,user_id,username,role,action,target,result,detail) VALUES(?,?,?,?,?,?,?,?)",
                      (time.time(), user and user.get("id"), user and user.get("username"), user and user.get("role"),
                       action, target, result, _j(detail or {})))

    def list_audit(self, limit: int = 200, result: Optional[str] = None) -> list[dict]:
        rows = self.q("SELECT * FROM audit" + (" WHERE result=?" if result else "") + " ORDER BY id DESC LIMIT ?",
                      ((result, limit) if result else (limit,)))
        for r in rows:
            r["detail"] = json.loads(r["detail"])
        return rows
