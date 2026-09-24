"""The bundle inspector joins a synthetic bundle written to the documented layouts.

    python3 -m unittest scripts/perf/test_session_bundle.py
"""
import json
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import session_bundle  # noqa: E402

EPOCH_UNIX_US = 1_790_000_000_000_000
PLAYER = 7


def snapshot_v2(tick, anchor_mm, body_handle, body_d):
    head = struct.pack("<BIHiiiBBBB", 112, tick, 0, *anchor_mm, 0, 1, 0, 0)
    self_state = bytes(33)
    sphere = struct.pack("<Hhhh", body_handle, *body_d) + bytes(12)
    return head + self_state + sphere


def write_bundle(root: Path, lose_one_datagram: bool):
    bundle = root / "session-t"
    server = bundle / "server"
    server.mkdir(parents=True)
    # Ticks 100..109: one snapshot each; the player at (10, 1, -5) m, a ball
    # 1.2345 m to +x of them. Sent 2 ms after the tick, received 3 ms later.
    tape_packets, records, world = [], [], b""
    for i, tick in enumerate(range(100, 110)):
        mono = 1_000_000 + i * 16_667
        packet = snapshot_v2(tick, (10_000, 1_000, -5_000), 5, (494, 0, 0))  # 494 * 2.5 mm = 1.235 m
        records.append(struct.pack("<IIQQIIBBBx", PLAYER, tick, mono + 1000, mono + 2000, len(packet),
                                   zlib.crc32(packet), 112, 1, 0))
        if not (lose_one_datagram and tick == 105):
            arrival_tape_ms = (mono + 5000) / 1000.0  # tape clock == capture clock here
            tape_packets.append((arrival_tape_ms, 2, packet))
        players = struct.pack("<IBBH8f", PLAYER, 1, 100, 0, 10.0, 1.0, -5.0, 0, 0, 0, 0, 0)
        body = struct.pack("<IHB16f", 900, 5, 0, 11.2345, 1.0, -5.0, 0, 0, 0, 1, *([0.1] * 3), *([0.0] * 6))
        world += struct.pack("<IQQHHI", tick, mono + 16_000, EPOCH_UNIX_US + mono + 16_000, 1, 0, 1) + players + body
    # A reliable packet, and a datagram ping the tape never records.
    reliable = bytes([120, 1, 2, 3])
    records.append(struct.pack("<IIQQIIBBBx", PLAYER, 104, 1_070_000, 1_070_500, 4, zlib.crc32(reliable), 120, 0, 0))
    tape_packets.append((1_071.0 + 0.8, 1, reliable))
    records.append(struct.pack("<IIQQIIBBBx", PLAYER, 104, 1_070_000, 1_070_100, 5, 0, 110, 1, 0))
    # A snapshot the server dropped on a full queue.
    records.append(struct.pack("<IIQQIIBBBx", PLAYER, 106, 1_100_000, 1_100_000, 90, 1, 112, 1, 2))
    tape_packets.sort()

    header = {"epoch_unix_us": EPOCH_UNIX_US}
    h = json.dumps(header).encode()
    (server / "sendlog.bin").write_bytes(b"VLSEND01" + struct.pack("<I", len(h)) + h + b"".join(records))
    w = json.dumps({"version": 1}).encode()
    (server / "world.bin").write_bytes(b"VLWORLD1" + struct.pack("<I", len(w)) + w + world)
    (server / "ticks.jsonl").write_text("".join(
        json.dumps({"tick": t, "mono_us": 1_000_000 + i * 16_667 + 16_000,
                    "unix_us": EPOCH_UNIX_US + 1_000_000 + i * 16_667 + 16_000,
                    "total_ms": 3.0, "capture_ms": 0.05}) + "\n"
        for i, t in enumerate(range(100, 110))))
    (server / "selections.jsonl").write_text(json.dumps(
        {"tick": 100, "player": PLAYER, "stream": "snapshot", "bodies_aoi": 3, "bodies_budget": 1}) + "\n")
    tape_header = {
        "version": 2, "localPlayerId": PLAYER, "durationMs": 1000.0, "frames": 0, "frameBytes": 60,
        "clockOriginMs": 0.0, "wallClockOriginMs": EPOCH_UNIX_US / 1000.0,
        "pairing": {"sessionId": "t", "state": "paired", "clockSamples": [
            {"what": "start", "sentPerfMs": 999.0, "receivedPerfMs": 1001.0, "serverTick": 99,
             "serverUnixUs": EPOCH_UNIX_US + 1_000_000, "serverMonoUs": 1_000_000}]},
    }
    th = json.dumps(tape_header).encode()
    body = b"".join(struct.pack("<dIB", t, len(p), ch) + p for t, ch, p in tape_packets)
    (bundle / "client.vltape").write_bytes(b"VLCTAPE2" + struct.pack("<I", len(th)) + th + body)
    (bundle / "session.json").write_text(json.dumps({
        "session_id": "t", "match_id": "city-default", "client_player_id": PLAYER,
        "server": {"dir": "server", "start": {"tick": 99}, "stop": {"tick": 111}, "sim_hz": 60},
    }))
    return bundle


class SessionBundle(unittest.TestCase):
    def test_joins_packets_maps_clocks_and_measures_position_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = session_bundle.analyse(str(write_bundle(Path(tmp), lose_one_datagram=True)))
        self.assertEqual(report["join"]["matched"], 10)  # 9 snapshots + 1 reliable
        self.assertEqual(report["join"]["unmatched_by_channel"], {})
        datagrams = report["channels"]["wt-datagram"]
        self.assertEqual(datagrams["in_window_lost"], 1)
        self.assertEqual(datagrams["received_packets"], 9)
        self.assertEqual(datagrams["server_queue-full"], 1)
        self.assertEqual(datagrams["in_window_untaped_pings"], 1)
        clock = report["clock"]
        # Datagrams: sent at +2 ms, arrived at +5 ms on a shared clock.
        self.assertAlmostEqual(clock["latency_wall_by_lane_ms"]["wt-datagram"]["p50"], 3.0, places=3)
        self.assertAlmostEqual(clock["latency_sample_offset_ms"]["p50"], 3.0, places=3)
        self.assertAlmostEqual(clock["queue_to_send_ms"]["p50"], 1.0, places=3)
        self.assertEqual(clock["snapshot_tick_disagreements"], 0)
        errors = report["position_error_mm"]
        self.assertLess(errors["self"]["max"], 0.01)
        # 1.235 m on the wire vs 1.2345 m true: the 2.5 mm grid, 0.5 mm off.
        self.assertAlmostEqual(errors["body"]["p50"], 0.5, places=2)
        self.assertEqual(report["selections"]["snapshot"]["bodies_budget"], 1)


if __name__ == "__main__":
    unittest.main()
