"""③ 데이터 — SQLite 스키마/CRUD, 상태 전이, 정비 연동, 비행 기록, 경보·감사, 재기동 영속성."""
import json
import tempfile
import time
import unittest
from pathlib import Path

from _util import wp

from ugcs.data.db import Conflict, Database, NotFound


class DatabaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "t.sqlite3"
        self.db = Database(self.path)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_seed(self):
        self.assertEqual({u["role"] for u in self.db.list_users()}, {"PILOT", "MISSION_CTRL", "MAINTENANCE", "OBSERVER"})
        self.assertEqual(self.db.get_aircraft("UAV-02")["status"], "GROUNDED")
        self.assertGreaterEqual(len(self.db.nfz()), 2)
        self.assertIsNotNone(self.db.default_geofence())
        self.assertTrue(self.db.health()["ok"])

    def test_login_pin_hashed(self):
        self.assertIsNotNone(self.db.verify_login("pilot1", "1111"))
        self.assertIsNone(self.db.verify_login("pilot1", "0000"))
        raw = self.db.q1("SELECT pin_hash FROM users WHERE username='pilot1'")["pin_hash"]
        self.assertNotIn("1111", raw)
        tok = self.db.create_session(1, 60)
        self.assertEqual(self.db.session_user(tok)["username"], "pilot1")
        self.db.delete_session(tok)
        self.assertIsNone(self.db.session_user(tok))

    def test_mission_crud_versioning_and_transitions(self):
        m = self.db.create_mission(name="정찰 A", aircraft_id="UAV-01", waypoints=[wp(0, 500)], created_by=1)
        self.assertEqual((m["status"], m["version"]), ("DRAFT", 1))
        self.assertEqual(m["waypoints"][0]["alt"], 50)
        self.db.set_mission_status(m["id"], "READY")
        m2 = self.db.update_mission(m["id"], waypoints=[wp(0, 600), wp(100, 600)])
        self.assertEqual((m2["status"], m2["version"], len(m2["waypoints"])), ("DRAFT", 2, 2))   # 수정 시 재검증 필요
        with self.assertRaises(Conflict):
            self.db.set_mission_status(m["id"], "UPLOADED")             # 수동 전이 불가
        self.db.set_mission_status(m["id"], "UPLOADED", system=True)
        with self.assertRaises(Conflict):
            self.db.delete_mission(m["id"])
        self.db.set_mission_status(m["id"], "ARCHIVED")
        with self.assertRaises(Conflict):
            self.db.update_mission(m["id"], name="x")
        self.db.set_mission_status(m["id"], "DRAFT")
        self.db.delete_mission(m["id"])
        with self.assertRaises(NotFound):
            self.db.get_mission(m["id"])

    def test_mission_validation_of_fields(self):
        with self.assertRaises(ValueError):
            self.db.create_mission(name="  ", aircraft_id="UAV-01", waypoints=[])
        with self.assertRaises(NotFound):
            self.db.create_mission(name="x", aircraft_id="UAV-99", waypoints=[])

    def test_maintenance_updates_aircraft_status(self):
        r = self.db.add_maintenance(aircraft_id="UAV-02", date="2026-11-16", technician="최정비", mtype="부품교체",
                                    checklist=[{"item": "모터 #3", "ok": True}], notes="모터 교체",
                                    result_status="AIRWORTHY", created_by=4)
        self.assertEqual(r["checklist"][0]["item"], "모터 #3")
        self.assertEqual(self.db.get_aircraft("UAV-02")["status"], "AIRWORTHY")
        self.assertEqual(self.db.list_maintenance("UAV-02")[0]["mtype"], "부품교체")
        with self.assertRaises(ValueError):
            self.db.add_maintenance(aircraft_id="UAV-01", date="2026-11-16", technician="x", mtype="세차",
                                    checklist=[], notes="", result_status="AIRWORTHY", created_by=4)

    def test_flight_telemetry_and_alert_history(self):
        fid = self.db.start_flight("UAV-01", None, 1)
        for i in range(5):
            self.db.add_telemetry(fid, time.time() + i, {"lat": 36.14 + i * 1e-4, "lon": 128.39, "alt_rel": i * 10})
        aid = self.db.raise_alert(code="BATTERY_LOW", severity="WARNING", message="배터리 주의", cause="29%", flight_id=fid)
        lid = self.db.raise_alert(code="GROUNDED_TAKEOFF", severity="CRITICAL", message="m", cause="c", latched=True)
        self.db.clear_alert_code("BATTERY_LOW")
        self.db.end_flight(fid, distance_m=44.5, max_alt_m=40, reason="정상 착륙")
        f = self.db.get_flight(fid)
        self.assertEqual((f["samples"], f["end_reason"]), (5, "정상 착륙"))
        tel = self.db.flight_telemetry(fid)
        self.assertEqual([t["alt_rel"] for t in tel], [0, 10, 20, 30, 40])
        self.assertIsNotNone(self.db.get_alert(aid)["cleared_at"])
        a = self.db.ack_alert(lid, 3)
        self.assertIsNotNone(a["acked_at"])
        self.assertIsNotNone(a["cleared_at"])                             # 이벤트형 경보는 인지 시 해제
        self.assertGreater(self.db.get_aircraft("UAV-01")["total_flight_s"], 0)

    def test_audit_log(self):
        self.db.audit(user={"id": 5, "username": "obs1", "role": "OBSERVER"}, action="CMD_TAKEOFF", target="UAV-01",
                      result="DENIED", detail={"reason": "권한 없음"})
        rows = self.db.list_audit(result="DENIED")
        self.assertEqual(rows[0]["detail"]["reason"], "권한 없음")

    def test_persistence_across_restart(self):
        m = self.db.create_mission(name="재기동 확인", aircraft_id="UAV-01", waypoints=[wp(0, 300)])
        self.db.audit(user=None, action="X", result="ALLOWED")
        self.db.save_lock(2, 123.0)
        fid = self.db.start_flight("UAV-01", m["id"], 1)
        self.db.close()
        self.db = Database(self.path)                                      # 전원 재투입
        self.assertEqual(self.db.get_mission(m["id"])["name"], "재기동 확인")
        self.assertEqual(self.db.list_audit()[0]["action"], "X")
        self.assertEqual(self.db.load_lock()["holder_id"], 2)
        self.assertEqual(self.db.open_flight()["id"], fid)
        self.assertEqual(len(self.db.list_users()), 5)                    # 시드 중복 없음
        self.assertEqual(self.db.q1("PRAGMA journal_mode")["journal_mode"], "wal")

    def test_json_columns_roundtrip(self):
        fence = [[36.1, 128.3], [36.2, 128.3], [36.2, 128.4]]
        m = self.db.create_mission(name="f", aircraft_id="UAV-01", waypoints=[], geofence=fence)
        self.assertEqual(self.db.get_mission(m["id"])["geofence"], fence)
        json.dumps(self.db.list_missions())


if __name__ == "__main__":
    unittest.main()
