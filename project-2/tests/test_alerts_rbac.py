"""② 처리 — 경보 판단 룰엔진 + 조작 권한(RBAC/제어권)."""
import unittest

from _util import HOME, PROJ, square

from ugcs.processing.alerts import RuleEngine
from ugcs.processing.rbac import (FLIGHT_COMMANDS, PERMISSIONS, AuthorizationError, ConflictError,
                                  ControlLock, LockState, Role, User, has_perm)


def snap(**kw):
    base = {"link": {"hb_age_s": 0.3, "latency_ms": 40, "loss_pct": 0}, "battery_pct": 90.0,
            "gps": {"fix": 3, "sats": 15}, "armed": True, "mode": "HOLD",
            "pos": {"lat": HOME["lat"] + 0.001, "lon": HOME["lon"], "alt": 50}, "mission_leg": None}
    base.update(kw)
    return base


def pos(x, y, alt=50):
    lat, lon = PROJ.to_ll(x, y)
    return {"lat": lat, "lon": lon, "alt": alt}


def codes(events, typ="RAISE"):
    return {e.code for e in events if e.type == typ}


class RuleEngineTest(unittest.TestCase):
    def setUp(self):
        self.e = RuleEngine()
        self.ctx = {"nfz": [{"name": "탄약고", "polygon": square(1000, 1000, 200)}],
                    "geofence": square(0, 0, 2000), "gcs": HOME, "comm_radius_m": 5000}

    def test_nominal_no_alerts(self):
        self.assertEqual(self.e.evaluate(snap(), self.ctx), [])

    def test_link_lost_raise_and_clear(self):
        ev = self.e.evaluate(snap(link={"hb_age_s": 3.5}), self.ctx)
        self.assertEqual(codes(ev), {"LINK_LOST"})
        self.assertEqual(ev[0].severity, "CRITICAL")
        self.assertEqual(self.e.evaluate(snap(link={"hb_age_s": 3.9}), self.ctx), [])  # 중복 발생 없음
        ev = self.e.evaluate(snap(), self.ctx)
        self.assertEqual(codes(ev, "CLEAR"), {"LINK_LOST"})

    def test_no_heartbeat_ever_is_link_lost(self):
        self.assertIn("LINK_LOST", codes(self.e.evaluate(snap(link={"hb_age_s": None}), self.ctx)))

    def test_latency_escalation(self):
        ev = self.e.evaluate(snap(link={"hb_age_s": 0.2, "latency_ms": 500, "loss_pct": 0}), self.ctx)
        self.assertEqual([(x.code, x.severity) for x in ev], [("LINK_LATENCY", "WARNING")])
        ev = self.e.evaluate(snap(link={"hb_age_s": 0.2, "latency_ms": 1500, "loss_pct": 0}), self.ctx)
        self.assertEqual([(x.type, x.severity) for x in ev], [("CLEAR", "WARNING"), ("RAISE", "CRITICAL")])

    def test_packet_loss(self):
        self.assertIn("LINK_LOSS", codes(self.e.evaluate(snap(link={"hb_age_s": 0.2, "loss_pct": 30}), self.ctx)))

    def test_battery_thresholds_and_hysteresis(self):
        self.assertEqual(codes(self.e.evaluate(snap(battery_pct=29.0), self.ctx)), {"BATTERY_LOW"})
        self.assertEqual(self.e.evaluate(snap(battery_pct=31.0), self.ctx), [])        # 히스테리시스 2%
        ev = self.e.evaluate(snap(battery_pct=14.0), self.ctx)
        self.assertEqual(codes(ev), {"BATTERY_CRITICAL"})
        self.assertEqual(codes(ev, "CLEAR"), {"BATTERY_LOW"})
        self.assertIn("BATTERY_CRITICAL", self.e.active)
        self.assertEqual(codes(self.e.evaluate(snap(battery_pct=40.0), self.ctx), "CLEAR"), {"BATTERY_CRITICAL"})

    def test_geofence_breach(self):
        ev = self.e.evaluate(snap(pos=pos(2500, 0)), self.ctx)
        self.assertIn("GEOFENCE_BREACH", codes(ev))

    def test_nfz_entry(self):
        ev = self.e.evaluate(snap(pos=pos(1000, 1000)), self.ctx)
        self.assertIn("NFZ_ENTRY", codes(ev))
        self.assertEqual([x.severity for x in ev if x.code == "NFZ_ENTRY"], ["CRITICAL"])

    def test_airspace_ignored_on_ground(self):
        self.assertEqual(self.e.evaluate(snap(pos=pos(1000, 1000, 0), armed=False), self.ctx), [])

    def test_route_deviation(self):
        leg = [PROJ.to_ll(0, 0), PROJ.to_ll(0, 1000)]
        ok = self.e.evaluate(snap(mode="MISSION", pos=pos(30, 500), mission_leg=leg), self.ctx)
        self.assertNotIn("ROUTE_DEVIATION", codes(ok))
        ev = self.e.evaluate(snap(mode="MISSION", pos=pos(120, 500), mission_leg=leg), self.ctx)
        self.assertIn("ROUTE_DEVIATION", codes(ev))

    def test_comm_range(self):
        ctx = dict(self.ctx, geofence=None, nfz=[])
        self.assertIn("COMM_RANGE", codes(self.e.evaluate(snap(pos=pos(0, 4700)), ctx)))

    def test_gps_degraded(self):
        self.assertIn("GPS_DEGRADED", codes(self.e.evaluate(snap(gps={"fix": 2, "sats": 4}), self.ctx)))

    def test_stale_alerts_frozen_during_link_loss(self):
        self.e.evaluate(snap(battery_pct=25), self.ctx)
        ev = self.e.evaluate(snap(battery_pct=None, link={"hb_age_s": 9}), self.ctx)
        self.assertEqual(codes(ev, "CLEAR"), set())                # 배터리 경보 유지
        self.assertIn("BATTERY_LOW", self.e.active)

    def test_latched_event(self):
        ev = self.e.raise_event("GROUNDED_TAKEOFF", "CRITICAL", "정비 불가 기체 이륙 시도", "UAV-02 GROUNDED")
        self.assertEqual(ev.type, "RAISE")
        self.assertEqual(self.e.evaluate(snap(), self.ctx), [])    # 조건 평가로 해제되지 않음
        self.assertEqual(self.e.clear_latched("GROUNDED_TAKEOFF").type, "CLEAR")


def user(i, role):
    return User(i, f"u{i}", f"사용자{i}", Role(role))


class RbacTest(unittest.TestCase):
    def setUp(self):
        self.saved = []
        self.lock = ControlLock(persist=self.saved.append)
        self.pilot, self.pilot2 = user(1, "PILOT"), user(2, "PILOT")
        self.mc, self.maint, self.obs = user(3, "MISSION_CTRL"), user(4, "MAINTENANCE"), user(5, "OBSERVER")

    def test_four_roles_defined(self):
        self.assertEqual({r.value for r in Role}, {"PILOT", "MISSION_CTRL", "MAINTENANCE", "OBSERVER"})

    def test_permission_matrix(self):
        for c in FLIGHT_COMMANDS:
            self.assertTrue(has_perm(self.pilot, f"cmd.{c}"))
            self.assertTrue(has_perm(self.mc, f"cmd.{c}"))
            self.assertFalse(has_perm(self.maint, f"cmd.{c}"))
            self.assertFalse(has_perm(self.obs, f"cmd.{c}"))
        self.assertTrue(has_perm(self.maint, "maint.write"))
        self.assertFalse(has_perm(self.pilot, "maint.write"))
        self.assertFalse(has_perm(self.pilot, "mission.approve"))
        self.assertTrue(has_perm(self.mc, "mission.approve"))
        self.assertEqual(PERMISSIONS[Role.OBSERVER], frozenset(p for p in PERMISSIONS[Role.OBSERVER] if p.endswith(".read")))

    def test_command_requires_control(self):
        with self.assertRaises(AuthorizationError) as cm:
            self.lock.authorize_command(self.pilot, "TAKEOFF")
        self.assertEqual(cm.exception.code, "NO_CONTROL")
        self.lock.acquire(self.pilot)
        self.lock.authorize_command(self.pilot, "TAKEOFF")             # 통과
        with self.assertRaises(AuthorizationError):
            self.lock.authorize_command(self.pilot2, "RTL")              # 같은 역할이라도 제어권 없으면 거부
        self.assertEqual(self.saved[-1].holder_id, 1)                    # 영속화 콜백 호출

    def test_role_denied_even_with_lock_state(self):
        self.lock = ControlLock(LockState(holder_id=5, holder_name="obs"))  # 비정상 상태 가정
        with self.assertRaises(AuthorizationError) as cm:
            self.lock.authorize_command(self.obs, "ESTOP")
        self.assertEqual(cm.exception.code, "ROLE_DENIED")

    def test_observer_and_maintenance_cannot_acquire(self):
        for u in (self.obs, self.maint):
            with self.assertRaises(AuthorizationError):
                self.lock.acquire(u)

    def test_single_holder_and_force(self):
        self.lock.acquire(self.pilot)
        with self.assertRaises(ConflictError):
            self.lock.acquire(self.pilot2)
        with self.assertRaises(AuthorizationError) as cm:
            self.lock.acquire(self.pilot2, force=True)                   # 조종사는 강제 인수 불가
        self.assertEqual(cm.exception.code, "FORCE_DENIED")
        st = self.lock.acquire(self.mc, force=True)                      # 임무통제관 강제 인수
        self.assertEqual(st.holder_id, 3)
        with self.assertRaises(AuthorizationError):
            self.lock.authorize_command(self.pilot, "LAND")

    def test_release_only_by_holder(self):
        self.lock.acquire(self.pilot)
        with self.assertRaises(AuthorizationError):
            self.lock.release(self.pilot2)
        self.lock.release(self.pilot)
        self.assertIsNone(self.lock.holder())

    def test_unknown_and_unauthenticated(self):
        with self.assertRaises(AuthorizationError):
            self.lock.authorize_command(None, "TAKEOFF")
        self.lock.acquire(self.pilot)
        with self.assertRaises(AuthorizationError):
            self.lock.authorize_command(self.pilot, "SELF_DESTRUCT")


if __name__ == "__main__":
    unittest.main()
