"""⑤ 인프라/통합 — 로컬 서버를 실제로 띄워 API·권한 차단(403)·감사 로그·헬스체크·영속성·폐쇄망 정책 확인."""
import json
import re
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from _util import ROOT, wp

from ugcs.server.app import create_app


class Client:
    def __init__(self, base):
        self.base, self.token = base, None

    def req(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        if self.token:
            r.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                payload = resp.read()
                return resp.status, (payload if raw else json.loads(payload or b"null")), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null"), dict(e.headers)

    def login(self, user, pin):
        st, body, _ = self.req("POST", "/api/auth/login", {"username": user, "pin": pin})
        assert st == 200, body
        self.token = body["token"]
        return self


class ServerCase(unittest.TestCase):
    @classmethod
    def boot(cls, db_path):
        httpd, svc = create_app(db_path, "127.0.0.1", 0)
        t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
        t.start()
        return httpd, svc, f"http://127.0.0.1:{httpd.server_address[1]}"

    @classmethod
    def shutdown(cls, httpd, svc):
        httpd.shutdown()
        svc.stop()
        svc.db.close()
        httpd.server_close()

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db_path = str(Path(cls.tmp.name) / "api.sqlite3")
        cls.httpd, cls.svc, cls.base = cls.boot(cls.db_path)
        time.sleep(1.2)            # 첫 하트비트 수신 대기

    @classmethod
    def tearDownClass(cls):
        cls.shutdown(cls.httpd, cls.svc)
        cls.tmp.cleanup()

    def client(self, user=None, pin=None):
        c = Client(self.base)
        return c.login(user, pin) if user else c

    def denied_count(self, action_prefix):
        return sum(1 for r in self.svc.db.list_audit(limit=1000, result="DENIED") if r["action"].startswith(action_prefix))


class ApiTest(ServerCase):
    def test_01_health_and_static_csp(self):
        st, h, _ = self.client().req("GET", "/health")
        self.assertEqual(st, 200)
        self.assertEqual(h["status"], "ok")
        self.assertTrue(h["db"]["ok"])
        self.assertTrue(h["datalink"]["connected"])
        st, html, hdr = self.client().req("GET", "/", raw=True)
        self.assertEqual(st, 200)
        self.assertIn(b"UGCS", html)
        self.assertIn("default-src 'self'", hdr["Content-Security-Policy"])
        self.assertIn("connect-src 'self'", hdr["Content-Security-Policy"])
        st, js, hdr = self.client().req("GET", "/js/map.js", raw=True)
        self.assertEqual(st, 200)
        self.assertIn("javascript", hdr["Content-Type"])
        st, _, _ = self.client().req("GET", "/../ugcs/config.py")
        self.assertIn(st, (403, 404))

    def test_02_auth_required(self):
        c = self.client()
        self.assertEqual(c.req("GET", "/api/state")[0], 401)
        self.assertEqual(c.req("POST", "/api/auth/login", {"username": "pilot1", "pin": "9999"})[0], 401)
        st, users, _ = c.req("GET", "/api/users")
        self.assertEqual(st, 200)
        self.assertNotIn("pin_hash", json.dumps(users))

    def test_03_rbac_403_and_audit(self):
        obs = self.client("obs1", "4444")
        before = self.denied_count("CMD_")
        st, body, _ = obs.req("POST", "/api/commands/TAKEOFF", {"alt": 30})
        self.assertEqual(st, 403)
        self.assertEqual(body["error"], "ROLE_DENIED")
        self.assertEqual(obs.req("POST", "/api/control/acquire", {})[0], 403)
        self.assertEqual(obs.req("POST", "/api/missions", {"name": "x", "waypoints": []})[0], 403)
        self.assertEqual(obs.req("POST", "/api/maintenance", {})[0], 403)
        self.assertEqual(obs.req("POST", "/api/sim", {"link_down": True})[0], 403)
        self.assertEqual(obs.req("GET", "/api/audit")[0], 403)
        self.assertEqual(self.denied_count("CMD_"), before + 1)
        actions = {r["action"] for r in self.svc.db.list_audit(limit=50, result="DENIED")}
        self.assertTrue({"CONTROL_ACQUIRE", "POST /api/missions", "POST /api/maintenance", "POST /api/sim", "GET /api/audit"} <= actions)

    def test_04_control_lock_flow(self):
        p1, p2, mc = self.client("pilot1", "1111"), self.client("pilot2", "1112"), self.client("mc1", "2222")
        st, body, _ = p1.req("POST", "/api/commands/TAKEOFF", {"alt": 30})
        self.assertEqual((st, body["error"]), (403, "NO_CONTROL"))                 # 제어권 없음
        self.assertEqual(p1.req("POST", "/api/control/acquire", {})[0], 200)
        st, body, _ = p2.req("POST", "/api/control/acquire", {})
        self.assertEqual((st, body["error"]), (409, "LOCK_HELD"))
        self.assertEqual(p2.req("POST", "/api/control/acquire", {"force": True})[0], 403)
        st, body, _ = p2.req("POST", "/api/commands/RTL", {"confirm": "RTL"})
        self.assertEqual((st, body["error"]), (403, "NO_CONTROL"))                 # 다른 조종사 차단
        self.assertEqual(mc.req("POST", "/api/control/acquire", {"force": True})[0], 200)
        self.assertEqual(p1.req("POST", "/api/commands/LAND", {"confirm": "LAND"})[0], 403)  # 이양된 뒤 차단
        self.assertEqual(mc.req("POST", "/api/control/release", {})[0], 200)
        self.assertIn("CONTROL_FORCE", {r["action"] for r in self.svc.db.list_audit(limit=30)})

    def test_05_grounded_aircraft_blocked(self):
        mc = self.client("mc1", "2222")
        mc.req("POST", "/api/control/acquire", {"force": True})
        self.assertEqual(mc.req("POST", "/api/aircraft/UAV-02/select")[0], 200)
        st, body, _ = mc.req("POST", "/api/commands/TAKEOFF", {"alt": 30})
        self.assertEqual((st, body["error"]), (409, "AIRCRAFT_NOT_AIRWORTHY"))
        _, alerts, _ = mc.req("GET", "/api/alerts?active=1")
        g = [a for a in alerts if a["code"] == "GROUNDED_TAKEOFF"]
        self.assertTrue(g and g[0]["severity"] == "CRITICAL")
        self.assertEqual(mc.req("POST", f"/api/alerts/{g[0]['id']}/ack")[0], 200)
        _, alerts, _ = mc.req("GET", "/api/alerts?active=1")
        self.assertFalse([a for a in alerts if a["id"] == g[0]["id"]])           # 인지 → 해제
        # 정비사가 정비 완료 처리하면 투입 가능
        mt = self.client("maint1", "3333")
        st, _, _ = mt.req("POST", "/api/maintenance", {"aircraft_id": "UAV-02", "date": "2026-11-16", "technician": "최정비",
                                                         "mtype": "부품교체", "checklist": [{"item": "모터", "ok": True}],
                                                         "notes": "교체 완료", "result_status": "AIRWORTHY"})
        self.assertEqual(st, 201)
        _, ac, _ = mc.req("GET", "/api/aircraft")
        self.assertEqual({a["id"]: a["status"] for a in ac["aircraft"]}["UAV-02"], "AIRWORTHY")
        self.assertEqual(mc.req("POST", "/api/aircraft/UAV-01/select")[0], 200)
        mc.req("POST", "/api/control/release", {})

    def test_06_dangerous_command_needs_confirm(self):
        mc = self.client("mc1", "2222")
        mc.req("POST", "/api/control/acquire", {"force": True})
        st, body, _ = mc.req("POST", "/api/commands/ESTOP", {})
        self.assertEqual((st, body["error"]), (428, "CONFIRM_REQUIRED"))
        mc.req("POST", "/api/control/release", {})

    def test_07_mission_plan_upload_fly_record(self):
        mc = self.client("mc1", "2222")
        pilot = self.client("pilot1", "1111")
        mc.req("POST", "/api/control/release", {})
        # 경로 계산 API
        st, plan, _ = pilot.req("POST", "/api/route/compute", {"waypoints": [wp(0, 400, 30)]})
        self.assertEqual(st, 200)
        self.assertTrue(plan["ok"])
        self.assertEqual(len(plan["legs"]), 2)
        # 금지구역 통과 경로는 READY 불가
        nfz = self.svc.db.nfz()[0]["polygon"]
        c_lat = sum(p[0] for p in nfz) / len(nfz)
        c_lon = sum(p[1] for p in nfz) / len(nfz)
        st, bad, _ = pilot.req("POST", "/api/missions", {"name": "NFZ 통과", "aircraft_id": "UAV-01",
                                                         "waypoints": [{"lat": c_lat, "lon": c_lon, "alt": 60}]})
        self.assertEqual(st, 201)
        st, v, _ = pilot.req("POST", f"/api/missions/{bad['id']}/validate")
        self.assertIn("NFZ_CROSS", {i["code"] for i in v["issues"]})
        self.assertEqual(pilot.req("POST", f"/api/missions/{bad['id']}/status", {"status": "READY"})[0], 403)  # 조종사 승인 불가
        st, body, _ = mc.req("POST", f"/api/missions/{bad['id']}/status", {"status": "READY"})
        self.assertEqual((st, body["error"]), (409, "PLAN_INVALID"))
        # 정상 임무: 작성(조종사) → 승인(임무통제관) → 업로드/시작(제어권 보유 조종사)
        st, m, _ = pilot.req("POST", "/api/missions", {"name": "근거리 정찰", "aircraft_id": "UAV-01",
                                                       "waypoints": [wp(40, 60, 20, speed=8)]})
        self.assertEqual(mc.req("POST", f"/api/missions/{m['id']}/status", {"status": "READY"})[0], 200)
        self.assertEqual(pilot.req("POST", "/api/control/acquire", {})[0], 200)
        st, body, _ = pilot.req("POST", "/api/commands/UPLOAD_MISSION", {"mission_id": bad["id"]})
        self.assertEqual((st, body["error"]), (409, "MISSION_NOT_READY"))
        st, up, _ = pilot.req("POST", "/api/commands/UPLOAD_MISSION", {"mission_id": m["id"]})
        self.assertEqual(st, 200, up)
        self.assertTrue(up["ack"]["ok"])
        self.assertEqual(pilot.req("GET", f"/api/missions/{m['id']}")[1]["status"], "UPLOADED")
        st, start, _ = pilot.req("POST", "/api/commands/START_MISSION", {})
        self.assertEqual(st, 200, start)
        deadline = time.time() + 20
        while time.time() < deadline:
            s = pilot.req("GET", "/api/state")[1]
            if s["telemetry"].get("alt_rel", 0) > 8:
                break
            time.sleep(0.3)
        self.assertGreater(s["telemetry"]["alt_rel"], 8)
        self.assertIsNotNone(s["flight"])
        self.assertEqual(s["relative"]["in_range"], True)
        # 비상정지로 빠르게 종료 → 비행 기록 마감
        st, _, _ = pilot.req("POST", "/api/commands/ESTOP", {"confirm": "ESTOP"})
        self.assertEqual(st, 200)
        deadline = time.time() + 12
        while time.time() < deadline and pilot.req("GET", "/api/state")[1]["flight"]:
            time.sleep(0.3)
        _, flights, _ = pilot.req("GET", "/api/flights")
        f = flights[0]
        self.assertIsNotNone(f["ended_at"])
        self.assertEqual(f["mission_id"], m["id"])
        self.assertEqual(f["end_reason"], "ESTOP")
        _, tel, _ = pilot.req("GET", f"/api/flights/{f['id']}/telemetry")
        self.assertGreater(len(tel), 2)                                            # 재생용 시계열
        self.assertIn("lat", tel[0])
        pilot.req("POST", "/api/control/release", {})
        _, aud, _ = mc.req("GET", "/api/audit?limit=100")
        acts = [(r["action"], r["result"]) for r in aud]
        self.assertIn(("CMD_UPLOAD_MISSION", "ALLOWED"), acts)
        self.assertIn(("CMD_ESTOP", "ALLOWED"), acts)

    def test_08_link_loss_alert_via_simulator(self):
        mc = self.client("mc1", "2222")
        self.assertEqual(mc.req("POST", "/api/sim", {"link_down": True})[0], 200)
        deadline = time.time() + 8
        codes = set()
        while time.time() < deadline and "LINK_LOST" not in codes:
            codes = {a["code"] for a in mc.req("GET", "/api/alerts?active=1")[1]}
            time.sleep(0.3)
        self.assertIn("LINK_LOST", codes)
        mc.req("POST", "/api/sim", {"link_down": False})
        deadline = time.time() + 6
        while time.time() < deadline and "LINK_LOST" in codes:
            codes = {a["code"] for a in mc.req("GET", "/api/alerts?active=1")[1]}
            time.sleep(0.3)
        self.assertNotIn("LINK_LOST", codes)                                       # 복구 시 자동 해제
        hist = [a for a in mc.req("GET", "/api/alerts")[1] if a["code"] == "LINK_LOST"]
        self.assertIsNotNone(hist[0]["cleared_at"])

    def test_09_bad_input(self):
        mc = self.client("mc1", "2222")
        self.assertEqual(mc.req("POST", "/api/missions", {"name": "x", "waypoints": [{"lat": "a"}]})[0], 400)
        self.assertEqual(mc.req("GET", "/api/missions/99999")[0], 404)
        self.assertEqual(mc.req("GET", "/api/nothing")[0], 404)
        self.assertEqual(mc.req("DELETE", "/api/state")[0], 405)


class RestartPersistenceTest(unittest.TestCase):
    def test_data_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d) / "p.sqlite3")
            httpd, svc, base = ServerCase.boot(path)
            c = Client(base).login("pilot1", "1111")
            st, m, _ = c.req("POST", "/api/missions", {"name": "재기동 후에도 유지", "aircraft_id": "UAV-01", "waypoints": [wp(0, 300)]})
            self.assertEqual(st, 201)
            c.req("POST", "/api/control/acquire", {})
            ServerCase.shutdown(httpd, svc)                    # 전원 차단/재기동 모사
            httpd, svc, base = ServerCase.boot(path)
            try:
                c2 = Client(base)
                c2.token = c.token                             # 세션도 DB에 영속
                st, m2, _ = c2.req("GET", f"/api/missions/{m['id']}")
                self.assertEqual((st, m2["name"]), (200, "재기동 후에도 유지"))
                self.assertEqual(c2.req("GET", "/api/control")[1]["holder_name"], "김조종 (조종사)")
                self.assertIn("LOGIN", {r["action"] for r in svc.db.list_audit()})
            finally:
                ServerCase.shutdown(httpd, svc)


class AirGapPolicyTest(unittest.TestCase):
    """웹 리소스와 서버 코드에 외부 URL/CDN/폰트/타일 참조가 없는지 정적 검사."""

    def test_no_external_urls_in_web(self):
        pat = re.compile(r"(https?:)?//[a-z0-9.-]+\.[a-z]{2,}", re.I)
        allowed: set[str] = set()
        bad = []
        for p in (ROOT / "web").rglob("*"):
            if p.suffix in (".html", ".js", ".css", ".svg"):
                # XML 네임스페이스 선언(xmlns, xmlns:*)은 식별자일 뿐 네트워크 요청이 아니므로 제외
                text = re.sub(r'xmlns(:[\w-]+)?="[^"]*"', "", p.read_text(encoding="utf-8"))
                for mt in pat.finditer(text):
                    if not any(a in mt.group(0) for a in allowed):
                        bad.append(f"{p.relative_to(ROOT)}: {mt.group(0)}")
        self.assertEqual(bad, [])

    def test_no_third_party_python_imports(self):
        import ast
        import sys
        stdlib = set(sys.stdlib_module_names)
        for p in (ROOT / "ugcs").rglob("*.py"):
            tree = ast.parse(p.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    names = [node.module.split(".")[0]]
                else:
                    continue
                for n in names:
                    if n == "serial":       # 선택적 하드웨어 어댑터(함수 내부 지연 import)
                        continue
                    self.assertIn(n, stdlib | {"ugcs"}, f"{p.name}: {n}")


if __name__ == "__main__":
    unittest.main()
