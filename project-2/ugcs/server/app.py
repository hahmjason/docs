"""로컬 HTTP 서버 (Python 표준 라이브러리 http.server 기반, 외부 의존성 없음).

- REST API (/api/...) — JSON 입출력, 세션 토큰(쿠키 또는 Bearer) 인증
- SSE (/api/stream)   — 텔레메트리/경보/제어권 실시간 방송
- 정적 콘솔 (/)        — web/ 폴더 서빙, CSP로 외부 출처 로드 원천 차단
- 헬스체크 (/health)   — 인증 없이 DB/데이터링크/루프 상태 반환

권한 위반은 모두 403(미인증 401)으로 응답하고 감사 로그(audit)에 DENIED로 기록한다.
"""
from __future__ import annotations

import json
import mimetypes
import queue
import re
import sys
import time
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import parse_qs, urlparse

from .. import config
from ..data.db import Conflict, Database, NotFound
from ..processing.mission import MissionValidationError, plan_mission
from ..processing.rbac import (ROLE_LABEL, AuthorizationError, ConflictError, Role, User, has_perm, require)
from .service import ConfirmRequired, GroundControlService, LinkError, to_user

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; "
       "frame-ancestors 'none'; form-action 'self'")
MAX_BODY = 1_000_000
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


class HttpError(Exception):
    def __init__(self, status: int, reason: str, code: str = "ERROR"):
        super().__init__(reason)
        self.status, self.reason, self.code = status, reason, code


Route = tuple[str, re.Pattern, Callable, Optional[str], bool]   # method, path, handler, perm, audit


class Api:
    """라우팅 테이블 + 핸들러. 핸들러 시그니처: (ctx) -> (status, body)."""

    def __init__(self, svc: GroundControlService):
        self.svc = svc
        self.db: Database = svc.db
        self.routes: list[Route] = []
        r = self.add
        r("GET", r"/health", self.health, None)
        r("POST", r"/api/auth/login", self.login, None)
        r("POST", r"/api/auth/logout", self.logout, None)
        r("GET", r"/api/auth/me", self.me, "state.read")
        r("GET", r"/api/users", self.users, None)
        r("GET", r"/api/state", self.state, "state.read")
        r("GET", r"/api/zones", self.zones, "state.read")
        r("GET", r"/api/control", self.control, "state.read")
        r("POST", r"/api/control/acquire", self.control_acquire, None)        # 서비스에서 검증·감사
        r("POST", r"/api/control/release", self.control_release, None)
        r("POST", r"/api/commands/(?P<cmd>[A-Za-z_]+)", self.command, None)   # 권한·제어권은 서비스에서 검증
        r("POST", r"/api/route/compute", self.route_compute, "mission.read")
        r("GET", r"/api/missions", self.missions, "mission.read")
        r("POST", r"/api/missions", self.mission_create, "mission.write", True)
        r("GET", r"/api/missions/(?P<id>\d+)", self.mission_get, "mission.read")
        r("PUT", r"/api/missions/(?P<id>\d+)", self.mission_update, "mission.write", True)
        r("DELETE", r"/api/missions/(?P<id>\d+)", self.mission_delete, "mission.write", True)
        r("POST", r"/api/missions/(?P<id>\d+)/validate", self.mission_validate, "mission.read")
        r("POST", r"/api/missions/(?P<id>\d+)/status", self.mission_status, "mission.write", True)
        r("GET", r"/api/aircraft", self.aircraft, "state.read")
        r("POST", r"/api/aircraft/(?P<id>[A-Za-z0-9_-]+)/select", self.aircraft_select, "control.acquire")
        r("GET", r"/api/maintenance", self.maint_list, "maint.read")
        r("POST", r"/api/maintenance", self.maint_create, "maint.write", True)
        r("GET", r"/api/flights", self.flights, "flight.read")
        r("GET", r"/api/flights/(?P<id>\d+)", self.flight_get, "flight.read")
        r("GET", r"/api/flights/(?P<id>\d+)/telemetry", self.flight_telemetry, "flight.read")
        r("GET", r"/api/alerts", self.alerts, "alert.read")
        r("POST", r"/api/alerts/(?P<id>\d+)/ack", self.alert_ack, "alert.ack")
        r("GET", r"/api/audit", self.audit, "audit.read")
        r("GET", r"/api/sim", self.sim_get, "state.read")
        r("POST", r"/api/sim", self.sim_post, "sim.control")

    def add(self, method, pattern, fn, perm, audit=False):
        self.routes.append((method, re.compile("^" + pattern + "$"), fn, perm, audit))

    def match(self, method: str, path: str):
        allowed = False
        for m, rx, fn, perm, audit in self.routes:
            mt = rx.match(path)
            if mt:
                allowed = True
                if m == method:
                    return fn, perm, audit, mt.groupdict()
        if allowed:
            raise HttpError(405, "허용되지 않는 메서드", "METHOD_NOT_ALLOWED")
        return None

    # ---- 핸들러 --------------------------------------------------------
    def health(self, c):
        h = self.svc.health()
        return (200 if h["status"] == "ok" else 503), h

    def login(self, c):
        b = c["body"]
        u = self.db.verify_login(str(b.get("username", "")), str(b.get("pin", "")))
        if not u:
            self.db.audit(user={"username": b.get("username")}, action="LOGIN", result="DENIED",
                          detail={"reason": "PIN 불일치"})
            raise HttpError(401, "아이디 또는 PIN이 올바르지 않습니다", "BAD_LOGIN")
        tok = self.db.create_session(u["id"], config.SESSION_TTL_S)
        self.db.audit(user=u, action="LOGIN")
        c["set_cookie"] = tok
        return 200, {"token": tok, "user": to_user(u).as_dict()}

    def logout(self, c):
        if c["token"]:
            self.db.delete_session(c["token"])
        c["set_cookie"] = ""
        return 200, {"ok": True}

    def me(self, c):
        return 200, c["user"].as_dict()

    def users(self, c):
        return 200, [{**u, "role_label": ROLE_LABEL[Role(u["role"])]} for u in self.db.list_users()]

    def state(self, c):
        return 200, self.svc.state()

    def zones(self, c):
        return 200, {"zones": self.db.list_zones(), "comm_radius_m": self.svc.comm_radius_m,
                     "limits": config.LIMITS, "perf": config.PERF}

    def control(self, c):
        return 200, self.svc.lock.state.as_dict()

    def control_acquire(self, c):
        if c["user"] is None:
            raise AuthorizationError("인증되지 않은 요청", "UNAUTHENTICATED")
        return 200, self.svc.acquire_control(c["user"], force=bool(c["body"].get("force")))

    def control_release(self, c):
        u = c["user"]
        if u is None:
            raise AuthorizationError("인증되지 않은 요청", "UNAUTHENTICATED")
        return 200, self.svc.release_control(u, admin=bool(c["body"].get("force")))

    def command(self, c):
        return 200, self.svc.execute_command(c["user"], c["params"]["cmd"], c["body"])

    def route_compute(self, c):
        b = c["body"]
        home = b.get("home") or self.svc._gcs_pos()
        plan = plan_mission(home, b.get("waypoints") or [], nfz=self.db.nfz(),
                            geofence=b.get("geofence") or self.db.default_geofence(),
                            start_battery_pct=float(b.get("start_battery_pct", 100)))
        return 200, plan.as_dict()

    def missions(self, c):
        return 200, self.db.list_missions(include_archived=c["query"].get("archived", ["1"])[0] != "0")

    def mission_create(self, c):
        b = c["body"]
        m = self.db.create_mission(name=b.get("name", ""), aircraft_id=b.get("aircraft_id", self.svc.aircraft_id),
                                   waypoints=_wps(b.get("waypoints", [])), geofence=b.get("geofence"),
                                   home=b.get("home") or self.svc._gcs_pos(), created_by=c["user"].id)
        return 201, m

    def mission_get(self, c):
        return 200, self.db.get_mission(int(c["params"]["id"]))

    def mission_update(self, c):
        b = c["body"]
        mid = int(c["params"]["id"])
        if self.svc.active_mission_id == mid:
            self.svc.active_mission_id = None   # 기체에 올라간 버전과 달라짐
        return 200, self.db.update_mission(mid, name=b.get("name"), aircraft_id=b.get("aircraft_id"),
                                           waypoints=_wps(b["waypoints"]) if "waypoints" in b else None,
                                           geofence=b.get("geofence"), home=b.get("home"))

    def mission_delete(self, c):
        self.db.delete_mission(int(c["params"]["id"]))
        return 200, {"deleted": int(c["params"]["id"])}

    def mission_validate(self, c):
        return 200, self.svc.validate_mission(c["user"], int(c["params"]["id"]))

    def mission_status(self, c):
        return 200, self.svc.set_mission_status(c["user"], int(c["params"]["id"]), str(c["body"].get("status", "")))

    def aircraft(self, c):
        return 200, {"aircraft": self.db.list_aircraft(), "active": self.svc.aircraft_id}

    def aircraft_select(self, c):
        return 200, self.svc.select_aircraft(c["user"], c["params"]["id"])

    def maint_list(self, c):
        return 200, self.db.list_maintenance(c["query"].get("aircraft_id", [None])[0])

    def maint_create(self, c):
        b = c["body"]
        return 201, self.db.add_maintenance(aircraft_id=b.get("aircraft_id", ""), date=b.get("date", ""),
                                            technician=b.get("technician") or c["user"].display_name,
                                            mtype=b.get("mtype", ""), checklist=b.get("checklist") or [],
                                            notes=b.get("notes", ""), result_status=b.get("result_status", ""),
                                            created_by=c["user"].id)

    def flights(self, c):
        return 200, self.db.list_flights()

    def flight_get(self, c):
        fid = int(c["params"]["id"])
        return 200, {**self.db.get_flight(fid), "alerts": self.db.list_alerts(flight_id=fid)}

    def flight_telemetry(self, c):
        return 200, self.db.flight_telemetry(int(c["params"]["id"]))

    def alerts(self, c):
        return 200, self.db.list_alerts(active_only=c["query"].get("active", ["0"])[0] == "1",
                                        limit=int(c["query"].get("limit", ["200"])[0]))

    def alert_ack(self, c):
        return 200, self.svc.ack_alert(c["user"], int(c["params"]["id"]))

    def audit(self, c):
        return 200, self.db.list_audit(limit=int(c["query"].get("limit", ["200"])[0]),
                                       result=c["query"].get("result", [None])[0])

    def sim_get(self, c):
        return 200, self.svc.sim_state() or {}

    def sim_post(self, c):
        return 200, self.svc.sim_control(c["user"], c["body"])


def _wps(raw) -> list:
    if not isinstance(raw, list):
        raise ValueError("waypoints는 배열이어야 합니다")
    from ..processing.mission import Waypoint
    out = []
    for i, w in enumerate(raw):
        try:
            wp = Waypoint.from_dict(w)
        except MissionValidationError as e:
            raise ValueError(f"WP{i + 1}: {e}") from e
        out.append(wp.__dict__.copy())
    return out


def make_handler(api: Api, web_root: Path):
    web_root = web_root.resolve()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "UGCS/1.0"
        sys_version = ""

        def log_message(self, fmt, *args):  # 조용한 접근 로그 (오류만 stderr)
            if len(args) > 1 and isinstance(args[1], str) and args[1].startswith(("4", "5")):
                sys.stderr.write("[ugcs] %s %s\n" % (self.address_string(), fmt % args))

        # ---- 공통 --------------------------------------------------------
        def _headers(self, status: int, ctype: str, length: Optional[int], extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            if length is not None:
                self.send_header("Content-Length", str(length))
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, status: int, body, cookie: Optional[str] = None):
            data = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
            extra = {}
            if cookie is not None:
                extra["Set-Cookie"] = (f"ugcs_token={cookie}; Path=/; HttpOnly; SameSite=Strict"
                                       + ("" if cookie else "; Max-Age=0"))
            self._headers(status, "application/json; charset=utf-8", len(data), extra)
            if self.command != "HEAD":
                self.wfile.write(data)

        def _token(self) -> str:
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                return auth[7:].strip()
            ck = SimpleCookie(self.headers.get("Cookie", ""))
            return ck["ugcs_token"].value if "ugcs_token" in ck else ""

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise HttpError(413, "요청 본문이 너무 큽니다", "TOO_LARGE")
            if not n:
                return {}
            try:
                b = json.loads(self.rfile.read(n).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise HttpError(400, "JSON 형식 오류", "BAD_JSON")
            if not isinstance(b, dict):
                raise HttpError(400, "JSON 객체가 필요합니다", "BAD_JSON")
            return b

        # ---- 메서드 ------------------------------------------------------
        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

        def _dispatch(self, method: str):
            url = urlparse(self.path)
            path = url.path
            if path == "/api/stream" and method == "GET":
                return self._sse()
            if not (path.startswith("/api/") or path == "/health"):
                if method != "GET":
                    return self._json(405, {"error": "METHOD_NOT_ALLOWED"})
                return self._static(path)
            user: Optional[User] = None
            token = ""
            action = f"{method} {path}"
            try:
                found = api.match(method, path)
                if not found:
                    raise HttpError(404, "없는 API 경로", "NOT_FOUND")
                fn, perm, audit, params = found
                token = self._token()
                user = to_user(api.db.session_user(token))
                body = self._body() if method in ("POST", "PUT", "DELETE") else {}
                if perm:
                    if user is None:
                        raise HttpError(401, "로그인이 필요합니다", "UNAUTHENTICATED")
                    require(user, perm)
                ctx = {"user": user, "token": token, "body": body, "params": params,
                       "query": parse_qs(url.query)}
                status, out = fn(ctx)
                if audit:
                    api.db.audit(user=user.as_dict() if user else None, action=action,
                                 target=params.get("id", ""), detail={"status": status})
                return self._json(status, out, ctx.get("set_cookie"))
            except AuthorizationError as e:
                if not path.startswith("/api/commands/") and not path.startswith("/api/control/"):
                    api.db.audit(user=user.as_dict() if user else None, action=action, result="DENIED",
                                 detail={"reason": e.reason, "code": e.code})
                return self._json(403 if e.code != "UNAUTHENTICATED" else 401,
                                  {"error": e.code, "message": e.reason})
            except HttpError as e:
                if e.status == 401 and path.startswith("/api/") and path not in ("/api/auth/login", "/api/auth/me"):
                    api.db.audit(user=None, action=action, result="DENIED", detail={"reason": e.reason})
                return self._json(e.status, {"error": e.code, "message": e.reason})
            except (ConflictError, ConfirmRequired, LinkError) as e:
                return self._json(e.status, {"error": e.code, "message": e.reason})
            except NotFound as e:
                return self._json(404, {"error": "NOT_FOUND", "message": str(e)})
            except Conflict as e:
                return self._json(409, {"error": "CONFLICT", "message": str(e)})
            except (ValueError, KeyError, TypeError) as e:
                return self._json(400, {"error": "BAD_REQUEST", "message": str(e)})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as e:  # pragma: no cover
                traceback.print_exc()
                return self._json(500, {"error": "INTERNAL", "message": str(e)})

        def _sse(self):
            user = to_user(api.db.session_user(self._token()))
            if not has_perm(user, "state.read"):
                api.db.audit(user=None, action="GET /api/stream", result="DENIED", detail={"reason": "미인증"})
                return self._json(401, {"error": "UNAUTHENTICATED"})
            self.close_connection = True
            self._headers(200, "text/event-stream; charset=utf-8", None, {"Connection": "close", "X-Accel-Buffering": "no"})
            q = api.svc.subscribe()
            try:
                self.wfile.write(f"event: state\ndata: {json.dumps(api.svc.state(), default=str, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()
                last_check = time.monotonic()
                while True:
                    try:
                        ev, data = q.get(timeout=10)
                        self.wfile.write(f"event: {ev}\ndata: {data}\n\n".encode("utf-8"))
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    if time.monotonic() - last_check > 30:   # 세션 만료/로그아웃 시 스트림 종료
                        last_check = time.monotonic()
                        if not api.db.session_user(self._token()):
                            break
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                api.svc.unsubscribe(q)

        def _static(self, path: str):
            rel = path.lstrip("/") or "index.html"
            target = (web_root / rel).resolve()
            if web_root not in target.parents and target != web_root:
                return self._json(403, {"error": "FORBIDDEN"})
            if target.is_dir():
                target = target / "index.html"
            if not target.is_file():
                return self._json(404, {"error": "NOT_FOUND", "message": path})
            data = target.read_bytes()
            ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
                ctype += "; charset=utf-8"
            self._headers(200, ctype, len(data))
            if self.command != "HEAD":
                self.wfile.write(data)

    return Handler


class UgcsServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def create_app(db_path: str | Path = config.DB_PATH, host: str = config.HOST, port: int = config.PORT,
               web_root: Path = config.WEB_ROOT, *, start: bool = True):
    db = Database(db_path)
    svc = GroundControlService(db)
    api = Api(svc)
    httpd = UgcsServer((host, port), make_handler(api, web_root))
    if start:
        svc.start()
    return httpd, svc
