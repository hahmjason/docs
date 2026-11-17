"""④ 시스템 연동 — 프레임 프로토콜, GNSS(NMEA) 파싱, 기체 시뮬레이터, 데이터링크 송수신."""
import time
import unittest

import _util  # noqa: F401  (sys.path 설정)

from ugcs.geo import haversine
from ugcs.integration import protocol as P
from ugcs.integration.datalink import LinkTimeout, SimulatedDataLink
from ugcs.integration.gnss import (AircraftGnssReceiver, NmeaError, SimulatedVehicleGnss, build_gga,
                                   build_rmc, fix_from_sentences, parse_nmea, relative)
from ugcs.integration.simulator import VehicleSimulator

GCS = {"lat": 36.14, "lon": 128.39}


class ProtocolTest(unittest.TestCase):
    def test_crc_x25_reference_vector(self):
        self.assertEqual(crc := P.crc16_x25(b"123456789"), 0x6F91, hex(crc))   # CRC-16/MCRF4XX 표준 검증값

    def test_roundtrip(self):
        fr = P.decode(P.encode(7, P.COMMAND, {"command": "RTL", "params": {"a": 1}}, sysid=255))
        self.assertEqual((fr.seq, fr.sysid, fr.msgid, fr.payload["command"]), (7, 255, P.COMMAND, "RTL"))

    def test_corruption_rejected(self):
        raw = bytearray(P.encode(1, P.TELEMETRY, {"x": 1}))
        raw[8] ^= 0x01
        with self.assertRaises(P.FrameError):
            P.decode(bytes(raw))

    def test_stream_parser_resync(self):
        a, b = P.encode(1, P.HEARTBEAT, {"m": 1}), P.encode(2, P.HEARTBEAT, {"m": 2})
        bad = bytearray(P.encode(3, P.HEARTBEAT, {"m": 3}))
        bad[-1] ^= 0xFF
        sp = P.StreamParser()
        stream = b"\x00garbage" + a + bytes(bad) + b
        out = sp.feed(stream[:10]) + sp.feed(stream[10:25]) + sp.feed(stream[25:])
        self.assertEqual([f.payload["m"] for f in out], [1, 2])
        self.assertGreaterEqual(sp.errors, 1)


class GnssTest(unittest.TestCase):
    def test_real_world_gga(self):
        s = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47"
        p = parse_nmea(s)
        self.assertAlmostEqual(p["lat"], 48.1173, places=4)
        self.assertAlmostEqual(p["lon"], 11.516667, places=5)
        self.assertEqual((p["sats"], p["fix"], p["alt_msl"]), (8, 3, 545.4))

    def test_build_parse_roundtrip(self):
        lat, lon = 36.1412345, 128.3987654
        fix = fix_from_sentences([build_gga(lat, lon, 112.3, 3, 14, 0.8), build_rmc(lat, lon, 12.5, 271.0)])
        self.assertLess(haversine(lat, lon, fix.lat, fix.lon), 0.05)      # 5 cm 이내
        self.assertAlmostEqual(fix.speed_mps, 12.5, delta=0.01)
        self.assertAlmostEqual(fix.course_deg, 271.0, delta=0.05)
        self.assertEqual((fix.fix, fix.sats), (3, 14))

    def test_southern_western_hemisphere(self):
        p = parse_nmea(build_gga(-33.8688, -151.2093, 10, 3, 9, 1.0))
        self.assertAlmostEqual(p["lat"], -33.8688, places=5)
        self.assertAlmostEqual(p["lon"], -151.2093, places=5)

    def test_checksum_and_no_fix(self):
        good = build_gga(36.14, 128.39, 50, 3, 10, 1.0)
        with self.assertRaises(NmeaError):
            parse_nmea(good[:-2] + "00")
        prev = fix_from_sentences([good])
        nofix = fix_from_sentences([build_gga(36.14, 128.39, 50, 0, 2, 9.9)], prev)
        self.assertFalse(nofix.valid)
        self.assertEqual(nofix.lat, prev.lat)       # 마지막 위치 유지

    def test_aircraft_receiver_and_relative(self):
        rx = AircraftGnssReceiver()
        fix = rx.ingest({"gnss": [build_gga(36.15, 128.39, 80, 3, 12, 0.7), "$BROKEN*00"]})
        self.assertEqual(rx.parse_errors, 1)
        gcs = SimulatedVehicleGnss(36.14, 128.39, noise_m=0).read()
        rel = relative(gcs, fix, 5000)
        self.assertAlmostEqual(rel["distance_m"], 1112, delta=3)
        self.assertAlmostEqual(rel["bearing_deg"], 0.0, delta=0.2)
        self.assertTrue(rel["in_range"])


class SimulatorTest(unittest.TestCase):
    def run_until(self, sim, cond, max_s=900, dt=0.1):
        t = 0.0
        while t < max_s:
            sim.gcs_heartbeat()
            sim.step(dt)
            t += dt
            if cond(sim):
                return t
        self.fail("조건 미충족")

    def test_takeoff_mission_rtl_land(self):
        sim = VehicleSimulator(**GCS)
        self.assertEqual(sim.handle_command("TAKEOFF", {"alt": 30})[0], "ACCEPTED")
        self.run_until(sim, lambda s: s.s.mode == "HOLD")
        self.assertAlmostEqual(sim.s.alt, 30, delta=1)
        ok, _ = sim.load_mission([{"lat": 36.142, "lon": 128.39, "alt": 40, "speed": 10, "hold": 5},
                                  {"lat": 36.142, "lon": 128.392, "alt": 40, "speed": 10}])
        self.assertTrue(ok)
        self.assertEqual(sim.handle_command("START_MISSION", {})[0], "ACCEPTED")
        self.run_until(sim, lambda s: s.s.mode == "RTL")
        self.run_until(sim, lambda s: s.s.mode == "LANDED")
        self.assertFalse(sim.s.armed)
        self.assertLess(haversine(sim.s.lat, sim.s.lon, GCS["lat"], GCS["lon"]), 5)
        self.assertLess(sim.s.battery_pct, 100)

    def test_link_loss_failsafe_rtl(self):
        sim = VehicleSimulator(**GCS)
        sim.handle_command("TAKEOFF", {"alt": 20})
        self.run_until(sim, lambda s: s.s.mode == "HOLD")
        from ugcs.geo import destination
        sim.s.lat, sim.s.lon = destination(GCS["lat"], GCS["lon"], 90, 400)   # 이착륙 지점에서 400 m 떨어진 곳
        for _ in range(int(11 / 0.1)):              # GCS 하트비트 없이 11초
            sim.step(0.1)
        self.assertEqual(sim.s.mode, "RTL")
        self.assertEqual(sim.failsafe, "LINK_LOSS_RTL")

    def test_estop_and_battery_guard(self):
        sim = VehicleSimulator(**GCS)
        sim.s.battery_pct = 20
        self.assertEqual(sim.handle_command("TAKEOFF", {"alt": 20})[0], "DENIED")
        sim.s.battery_pct = 100
        sim.handle_command("TAKEOFF", {"alt": 20})
        self.run_until(sim, lambda s: s.s.alt > 10)
        sim.handle_command("ESTOP", {})
        self.run_until(sim, lambda s: not s.s.armed, max_s=10)
        self.assertEqual(sim.failsafe, "ESTOP")

    def test_battery_drain_injection(self):
        a, b = VehicleSimulator(**GCS), VehicleSimulator(**GCS)
        b.faults.battery_drain_x = 10
        for s in (a, b):
            s.handle_command("TAKEOFF", {"alt": 20})
            for _ in range(100):
                s.gcs_heartbeat(); s.step(0.1)
        self.assertGreater(100 - b.s.battery_pct, 8 * (100 - a.s.battery_pct))


class DataLinkTest(unittest.TestCase):
    def setUp(self):
        self.sim = VehicleSimulator(**GCS)
        self.link = SimulatedDataLink(self.sim, gcs_position=lambda: GCS, tick_hz=100, telem_hz=10)
        self.telem = []
        self.link.on_telemetry(self.telem.append)
        self.link.start()
        time.sleep(0.6)

    def tearDown(self):
        self.link.stop()

    def test_telemetry_heartbeat_and_stats(self):
        st = self.link.stats()
        self.assertTrue(st["connected"])
        self.assertGreater(len(self.telem), 3)
        self.assertIn("gnss", self.telem[-1])
        self.assertTrue(parse_nmea(self.telem[-1]["gnss"][0]))
        self.assertLess(st["latency_ms"], 100)

    def test_command_ack(self):
        ack = self.link.send_command("TAKEOFF", {"alt": 15})
        self.assertTrue(ack.ok)
        self.assertEqual(ack.result, "ACCEPTED")
        ack2 = self.link.send_command("TAKEOFF", {"alt": 15})
        self.assertEqual(ack2.result, "DENIED")          # 이미 비행 중 → 기체가 거부(NACK)

    def test_mission_upload_handshake(self):
        items = [{"lat": 36.141 + i * 0.0005, "lon": 128.39, "alt": 30, "speed": 8, "hold": 0, "action": "WAYPOINT"} for i in range(12)]
        ack = self.link.upload_mission(items)
        self.assertTrue(ack.ok, ack)
        self.assertEqual(len(self.sim.mission), 12)

    def test_link_down_timeout_and_heartbeat_age(self):
        self.link.set_faults(link_down=True)
        with self.assertRaises(LinkTimeout):
            self.link.send_command("RTL", timeout=0.2, retries=2)
        time.sleep(3.2)
        st = self.link.stats()
        self.assertFalse(st["connected"])
        self.assertGreater(st["hb_age_s"], 3.0)
        self.link.set_faults(link_down=False)
        time.sleep(1.3)
        self.assertTrue(self.link.stats()["connected"])

    def test_retransmission_under_loss(self):
        self.link.set_faults(loss_pct=45)
        results = []
        for _ in range(4):
            try:
                results.append(self.link.send_command("GIMBAL", {"pitch": -45}, timeout=0.25, retries=6))
            except LinkTimeout:
                pass
        self.assertTrue(results)                              # 재전송으로 결국 ACK 수신
        self.assertTrue(any(r.attempts > 1 for r in results) or len(results) == 4)

    def test_latency_and_loss_measurement(self):
        self.link.set_faults(latency_ms=300, loss_pct=30)
        time.sleep(3.0)
        st = self.link.stats()
        self.assertGreater(st["latency_ms"], 150)
        self.assertGreater(st["loss_pct"], 5)

    def test_corrupted_frames_rejected_by_crc(self):
        self.link.set_faults(corrupt_pct=40)
        time.sleep(1.0)
        self.assertGreater(self.link.stats()["crc_errors"], 0)


if __name__ == "__main__":
    unittest.main()
