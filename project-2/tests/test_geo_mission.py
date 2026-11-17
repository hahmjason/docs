"""② 처리 — 측지 계산 및 임무 경로 계산기/검증기."""
import math
import unittest

from _util import HOME, square, wp

from ugcs import config
from ugcs.geo import (LocalProjection, bearing, destination, distance_to_segment, haversine,
                      point_in_polygon, segment_intersects_polygon, segments_intersect)
from ugcs.processing.mission import compute_route, plan_mission


class GeoTest(unittest.TestCase):
    def test_haversine_known_distance(self):
        # 서울시청 → 부산시청 대권거리 약 325 km
        d = haversine(37.5663, 126.9779, 35.1796, 129.0756)
        self.assertAlmostEqual(d / 1000, 325.0, delta=3.0)

    def test_one_degree_latitude(self):
        self.assertAlmostEqual(haversine(36, 128, 37, 128), 111_195, delta=50)

    def test_bearing_cardinals(self):
        self.assertAlmostEqual(bearing(36, 128, 36.01, 128), 0.0, places=3)
        self.assertAlmostEqual(bearing(36, 128, 36, 128.01), 90.0, delta=0.01)
        self.assertAlmostEqual(bearing(36, 128, 35.99, 128), 180.0, places=3)
        self.assertAlmostEqual(bearing(36, 128, 36, 127.99), 270.0, delta=0.01)

    def test_destination_roundtrip(self):
        lat, lon = destination(36.14, 128.39, 37.0, 2500.0)
        self.assertAlmostEqual(haversine(36.14, 128.39, lat, lon), 2500.0, delta=0.05)
        self.assertAlmostEqual(bearing(36.14, 128.39, lat, lon), 37.0, delta=0.01)

    def test_local_projection_accuracy(self):
        p = LocalProjection(36.14, 128.39)
        lat, lon = p.to_ll(3000, 4000)
        self.assertAlmostEqual(haversine(36.14, 128.39, lat, lon), 5000, delta=5)   # 0.1% 이내

    def test_polygon_and_segments(self):
        sq = [(0, 0), (10, 0), (10, 10), (0, 10)]
        self.assertTrue(point_in_polygon((5, 5), sq))
        self.assertFalse(point_in_polygon((15, 5), sq))
        self.assertTrue(segments_intersect((0, 0), (10, 10), (0, 10), (10, 0)))
        self.assertFalse(segments_intersect((0, 0), (1, 1), (2, 2), (3, 0)))
        self.assertTrue(segment_intersects_polygon((-5, 5), (15, 5), sq))      # 관통
        self.assertFalse(segment_intersects_polygon((-5, -5), (-5, 15), sq))   # 비켜감
        self.assertAlmostEqual(distance_to_segment((5, 3), (0, 0), (10, 0)), 3.0)
        self.assertAlmostEqual(distance_to_segment((14, 0), (0, 0), (10, 0)), 4.0)


class RouteCalculatorTest(unittest.TestCase):
    def test_totals_are_sum_of_legs(self):
        wps = [wp(0, 1000, 50), wp(1000, 1000, 80, hold=30), wp(1000, 0, 80)]
        r = compute_route(HOME, wps)
        self.assertEqual(len(r.legs), 4)                       # HOME→1→2→3→HOME
        self.assertAlmostEqual(r.total_distance_m, sum(l.distance_m for l in r.legs), places=6)
        self.assertAlmostEqual(r.total_distance_m, 1000 + 1000 + 1000 + 1000, delta=4)
        self.assertAlmostEqual(r.total_time_s, sum(l.time_s for l in r.legs), places=6)
        self.assertAlmostEqual(r.battery_end_pct, 100 - r.energy_pct, places=6)

    def test_leg_bearing_alt_and_time_model(self):
        r = compute_route(HOME, [wp(1000, 0, 60, speed=10)], return_home=False)
        leg = r.legs[0]
        self.assertAlmostEqual(leg.bearing_deg, 90.0, delta=0.1)
        self.assertEqual(leg.alt_change_m, 60.0)
        # 수평 100 s vs 상승 60/3 = 20 s → 100 s
        self.assertAlmostEqual(leg.time_s, 100.0, delta=0.5)
        p = config.PERF
        self.assertAlmostEqual(leg.energy_pct, 100.0 * p["cruise_drain_pct_s"] + 60 * p["climb_drain_pct_m"], delta=0.05)

    def test_climb_limited_leg(self):
        r = compute_route(HOME, [wp(10, 0, 120)], return_home=False)
        self.assertAlmostEqual(r.legs[0].time_s, 120 / config.PERF["climb_rate_mps"], delta=0.01)

    def test_hold_time_and_land_action(self):
        r = compute_route(HOME, [wp(0, 500, 50, hold=60, action="LOITER"), wp(0, 900, 30, action="LAND")])
        self.assertEqual(r.legs[-1].to, "WP2")                 # LAND면 귀환 구간 없음
        self.assertEqual(r.legs[0].hold_s, 60)


class RouteValidationTest(unittest.TestCase):
    def test_valid_plan(self):
        p = plan_mission(HOME, [wp(300, 600, 60), wp(-300, 600, 60)], geofence=square(0, 0, 3000))
        self.assertTrue(p.ok, p.issues)

    def test_nfz_crossing_detected(self):
        nfz = [{"name": "탄약고", "polygon": square(0, 1000, 150)}]
        p = plan_mission(HOME, [wp(0, 2000, 60)], nfz=nfz)
        self.assertFalse(p.ok)
        self.assertIn("NFZ_CROSS", {i.code for i in p.issues})

    def test_nfz_avoidance_passes(self):
        nfz = [{"name": "탄약고", "polygon": square(0, 1000, 150)}]
        p = plan_mission(HOME, [wp(500, 1000, 60), wp(500, 2000, 60), wp(0, 2000, 60)], nfz=nfz, return_home=False)
        self.assertNotIn("NFZ_CROSS", {i.code for i in p.issues})

    def test_geofence_exit_detected(self):
        p = plan_mission(HOME, [wp(0, 2500, 60)], geofence=square(0, 0, 1000))
        self.assertIn("GEOFENCE", {i.code for i in p.issues})

    def test_limits(self):
        codes = {i.code for i in plan_mission(HOME, [wp(0, 300, 400)]).issues}
        self.assertIn("MAX_ALT", codes)
        codes = {i.code for i in plan_mission(HOME, [wp(0, 6000, 60)]).issues}
        self.assertIn("MAX_RANGE", codes)
        codes = {i.code for i in plan_mission(HOME, [wp(0, 300, 60, speed=40)]).issues}
        self.assertIn("SPEED", codes)
        codes = {i.code for i in plan_mission(HOME, [wp(0, 300, 60, action="DANCE")]).issues}
        self.assertIn("WP_ACTION", codes)

    def test_battery_limit(self):
        # 정상 배터리로 가능한 경로도 시작 배터리 35%면 예비량 20% 미만
        wps = [wp(1500, 1500, 80, hold=120), wp(-1500, 1500, 80, hold=120)]
        ok = plan_mission(HOME, wps, start_battery_pct=100)
        self.assertNotIn("BATTERY", {i.code for i in ok.issues})
        low = plan_mission(HOME, wps, start_battery_pct=35)
        self.assertIn("BATTERY", {i.code for i in low.issues})
        self.assertFalse(low.ok)

    def test_invalid_input(self):
        p = plan_mission(HOME, [{"lat": "abc", "lon": 128}])
        self.assertFalse(p.ok)
        self.assertEqual(p.issues[0].code, "WP_INVALID")
        self.assertEqual(plan_mission(HOME, []).issues[0].code, "NO_WAYPOINTS")
        p = plan_mission(HOME, [{"lat": 95, "lon": 128}])
        self.assertEqual(p.issues[0].code, "WP_INVALID")

    def test_as_dict_serializable(self):
        import json
        d = plan_mission(HOME, [wp(0, 500, 50)]).as_dict()
        json.dumps(d)
        self.assertIn("legs", d)
        self.assertTrue(d["ok"])
        self.assertTrue(math.isfinite(d["total_time_s"]))


if __name__ == "__main__":
    unittest.main()
