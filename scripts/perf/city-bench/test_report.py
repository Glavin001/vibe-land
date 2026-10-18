"""Unit tests for the city-bench report helpers: python3 -m unittest scripts/perf/city-bench/test_report.py"""
import importlib.util
import os
import unittest

spec = importlib.util.spec_from_file_location("city_bench_report", os.path.join(os.path.dirname(__file__), "report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class Quantiles(unittest.TestCase):
    def test_nearest_rank(self):
        q = report.q(list(range(1, 101)))
        self.assertEqual((q["p50"], q["p95"], q["p99"], q["max"], q["n"]), (50, 95, 99, 100, 100))

    def test_empty_and_none(self):
        self.assertEqual(report.q([]), {"n": 0})
        self.assertEqual(report.q([None, 2.0])["max"], 2.0)


class Budgets(unittest.TestCase):
    def rep(self):
        return {"server": {"tick_ms": {"p95": 20.0}},
                "clients": [{"client": 0, "frames": {"hitches_over_100ms": 0}},
                            {"client": 1, "frames": {"hitches_over_100ms": 3}}]}

    def test_server_and_worst_client(self):
        cfg = {"budgets": [
            {"id": "tick", "metric": "server.tick_ms.p95", "op": "<", "value": 16.7},
            {"id": "hitch", "metric": "clients.*.frames.hitches_over_100ms", "op": "<=", "value": 0},
            {"id": "missing", "metric": "server.nope", "op": "<", "value": 1},
            {"id": "soft", "metric": "server.tick_ms.p95", "op": "<", "value": 1, "enabled": False},
        ]}
        r = {x["id"]: x for x in report.evaluate_budgets(self.rep(), cfg)}
        self.assertEqual(r["tick"]["status"], "fail")
        self.assertEqual((r["hitch"]["status"], r["hitch"]["observed"], r["hitch"]["where"]), ("fail", 3, "c1"))
        self.assertEqual(r["missing"]["status"], "n/a")
        self.assertEqual(r["soft"]["status"], "fail (not gating)")

    def test_greater_than_picks_minimum(self):
        cfg = {"budgets": [{"id": "rate", "metric": "clients.*.snapshots.per_server_tick", "op": ">=", "value": 0.98}]}
        rep = {"server": {}, "clients": [{"client": 0, "snapshots": {"per_server_tick": 1.0}},
                                         {"client": 1, "snapshots": {"per_server_tick": 0.9}}]}
        (r,) = report.evaluate_budgets(rep, cfg)
        self.assertEqual((r["status"], r["observed"], r["where"]), ("fail", 0.9, "c1"))


def meteor_rows(frames, body=None):
    """meteor_frames.csv rows for one flight: (source, drawn x, arc x), y = 5, z = 0;
    `body`: the streamed body's x per frame (None in it: not streamed then);
    without it the rows have no body columns, as tapes decoded before them."""
    rows = []
    for k, (source, x, arc_x) in enumerate(frames):
        row = {"frame_t_ms": str(k * 8.3), "body": "25", "launch_t_ms": "100.0", "source": source,
               "draw_x": str(x), "draw_y": "5", "draw_z": "0", "arc_x": str(arc_x), "arc_y": "5", "arc_z": "0",
               "raw_y": "5"}
        if body is not None:
            bx = body[k]
            row.update({"body_x": "" if bx is None else str(bx), "body_y": "" if bx is None else "5",
                        "body_z": "" if bx is None else "0"})
        rows.append(row)
    return rows


class Meteors(unittest.TestCase):
    # 130 m/s at 120 fps: 1.08 m a frame. The 2026-09-24 systematic run failed
    # net.meteor_arc_jump (1.10 m against < 1.0) with the handover measured
    # frame to frame, which counts that flight.
    STEP = 130 * 0.0083

    def test_handover_is_measured_against_the_arc_at_the_same_render_time(self):
        frames = [("arc", k * self.STEP, k * self.STEP) for k in range(10)]
        frames += [("body", k * self.STEP + 0.02, k * self.STEP) for k in range(10, 20)]
        m = report.meteor_metrics(meteor_rows(frames))
        self.assertAlmostEqual(m["arc_to_body_jump_m"]["max"], 0.02, places=3)
        self.assertGreater(m["arc_to_body_frame_step_m"]["max"], 1.0)
        self.assertEqual(m["backward_frames"], 0)

    def test_a_body_behind_the_arc_is_a_jump_and_one_backward_frame(self):
        # Handed over 1.5 m behind the arc (the old client's tick-scale bug at
        # tick ~10 000): the rock steps back once and carries on.
        frames = [("arc", k * self.STEP, k * self.STEP) for k in range(10)]
        frames += [("body", k * self.STEP - 1.5, k * self.STEP) for k in range(10, 20)]
        m = report.meteor_metrics(meteor_rows(frames))
        self.assertAlmostEqual(m["arc_to_body_jump_m"]["max"], 1.5, places=3)
        # One step back (0.42 m back, not 1 frame forward), counted once: the
        # step after it is the rock carrying on, not a second backward frame.
        self.assertEqual(m["backward_frames"], 1)

    def test_a_rock_that_bounces_as_it_is_handed_over_is_not_a_jump(self):
        # Contact inside the handover frame: the arc runs on into the wall,
        # the body turns back. The body's own step is what is drawn.
        arc = [k * self.STEP for k in range(20)]
        body = [k * self.STEP for k in range(11)] + [10 * self.STEP - (k - 10) * 0.4 for k in range(11, 20)]
        frames = [("arc", arc[k], arc[k]) for k in range(11)] + [("body", body[k], arc[k]) for k in range(11, 20)]
        m = report.meteor_metrics(meteor_rows(frames, body))
        self.assertLess(m["arc_to_body_jump_m"]["max"], 1e-9)
        # Against the arc at the same render time the bounce would read as a jump.
        m_old = report.meteor_metrics(meteor_rows(frames))
        self.assertGreater(m_old["arc_to_body_jump_m"]["max"], 1.0)

    def test_with_the_body_columns_the_bodys_own_bounce_is_not_backward(self):
        frames = [("body", k * self.STEP, 0) for k in range(10)]
        frames += [("body", 9 * self.STEP - (k - 9) * 0.6, 0) for k in range(10, 20)]
        body = [x for _, x, _ in frames]
        self.assertEqual(report.meteor_metrics(meteor_rows(frames, body))["backward_frames"], 0)
        # Drawn behind the body at the handover (the old tick-scale arc):
        # backward against the body's own motion too.
        frames = [("arc", k * self.STEP, k * self.STEP) for k in range(10)]
        frames += [("body", k * self.STEP - 1.5, k * self.STEP) for k in range(10, 20)]
        body = [k * self.STEP - 1.5 for k in range(20)]
        self.assertEqual(report.meteor_metrics(meteor_rows(frames, body))["backward_frames"], 1)

    def test_a_rock_first_streamed_after_impact_is_reported_apart(self):
        # Held on its arc's end (a guess: it hit something out of interest),
        # then its body streams in 79 m away.
        frames = [("arc", 100.0, 100.0) for _ in range(5)] + [("body", 21.0 + k * 0.5, 100.0) for k in range(5)]
        body = [None] * 5 + [21.0 + k * 0.5 for k in range(5)]
        m = report.meteor_metrics(meteor_rows(frames, body))
        self.assertEqual(m["arc_to_body_jump_m"]["max"], 0)
        self.assertAlmostEqual(m["unstreamed_arc_to_body_jump_m"]["max"], 79.0, places=3)

    def test_a_bounce_is_one_backward_frame(self):
        frames = [("body", k * self.STEP, k * self.STEP) for k in range(10)]
        frames += [("body", 9 * self.STEP - (k - 9) * 0.6, 0) for k in range(10, 20)]
        m = report.meteor_metrics(meteor_rows(frames))
        self.assertEqual(m["backward_frames"], 1)


class DrawingFrame(unittest.TestCase):
    def test_a_sample_belongs_to_the_frame_that_drew_it(self):
        frames = [1000.0, 1008.3, 1016.7]
        # Stamped 0.1 ms into the second frame: that frame, not the third.
        self.assertEqual(report.drawing_frame(frames, 1008.4), 1)
        # At a frame's own (float32-rounded) stamp, or a hair before it.
        self.assertEqual(report.drawing_frame(frames, 1016.7), 2)
        self.assertEqual(report.drawing_frame(frames, 1016.68), 2)
        self.assertIsNone(report.drawing_frame(frames, 990.0))


class TickScale(unittest.TestCase):
    def test_legacy_and_recorded_scales(self):
        self.assertEqual(report.snapshot_tick_us({}), 16_667)
        self.assertEqual(report.snapshot_tick_us({"serverTickUs": 16_666}), 16_666)


# ticks.jsonl lines: as servers wrote them before the phase fields, and after.
OLD_TICK = {"tick": 100, "mono_us": 0, "unix_us": 1_000_000_000, "total_ms": 40.0, "player_sim_ms": 0.1,
            "vehicle_ms": 0.0, "dynamics_ms": 38.0, "hitscan_ms": 0.0, "city_ms": 1.0, "snapshot_ms": 0.1,
            "publish_ms": 0.0, "unattributed_ms": 0.8, "players": 1, "awake_city_bodies": 300, "capture_ms": 0.2}


def new_tick(tick, promoted=0, bonds=0, fetch=30.0, zones=True, snapshot=True):
    t = dict(OLD_TICK, tick=tick, unix_us=1_000_000_000 + tick * 16_667, timing_version=2, snapshot_sent=snapshot,
             snapshot_ms=0.1 if snapshot else 0.0, shots_ms=0.0, meteors_launched=0, meteor_launch_ms=0.0,
             dynamics_ms=fetch + 2.0, total_ms=fetch + 4.0, phases_us=3.5)
    t["physx"] = {"controller_ms": 0.1, "submit_ms": 0.9, "overlap_ms": 0.5, "fetch_ms": fetch, "callbacks_ms": 0.1,
                  "readback_ms": 0.6, "players_ms": 0.05, "awake_bodies": 400,
                  "found_pairs": 50, "lost_pairs": 40}
    t["stage"] = {"frame": tick, "error": 0, "iterations": 16, "converged": False, "passes": 1 + (promoted > 0),
                  "corrections": int(promoted > 0), "bonds_broken": bonds, "bonds_broken_after_correction": 0,
                  "crushed_chunks": 0, "contacts": 2000, "bodies_promoted": promoted, "chunks_migrated": 3 * promoted,
                  "observe_ms": 0.4}
    if zones:
        t["stage"]["zones"] = {"finish_gpu_wait_ms": 1.5, "submit_ms": 1.0, "finish_ms": 2.0, "stress_gpu_ms": 1.2,
                               "fracture_gpu_ms": 0.3, "correction_ms": 20.0 if promoted else 0.0,
                               "correction_prep_ms": 3.0 if promoted else 0.0, "correction_gpu_ms": 0.2,
                               "body_alloc_ms": 0.1, "other_ms": 0.5}
        t["engine_zones"] = {"GpuDestruction.correctedCollisionSolve": 20.0} if promoted else {"GpuDestruction.submit": 1.0}
    return t


class _Levels:
    def at(self, _unix_ms):
        return {}


class TickPhases(unittest.TestCase):
    def metrics(self, ticks):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "ticks.jsonl"), "w") as f:
                f.write("\n".join(json.dumps(t) for t in ticks) + "\n")
            out, _ = report.server_metrics(d, [], (0, 2e12), _Levels(), None, "")
            return out

    def test_an_old_capture_still_reports_and_says_it_has_no_phases(self):
        ticks = [dict(OLD_TICK, tick=100 + k, unix_us=1_000_000_000 + k * 16_667) for k in range(10)]
        out = self.metrics(ticks)
        self.assertEqual(out["ticks"], 10)
        self.assertEqual(out["breakdown"]["dynamics_ms"]["p50"], 38.0)
        self.assertEqual(out["breakdown"]["shots_ms"]["p50"], 0.0)
        self.assertFalse(out["snapshot_ms_per_tick"])
        self.assertEqual(out["phases"], {})
        md = report.phase_md(out)
        self.assertIn("not in this capture", md[0])

    def test_a_new_capture_reports_phases_by_tick_class(self):
        ticks = [new_tick(200 + k, snapshot=k % 2 == 0) for k in range(20)]
        ticks[5] = new_tick(205, promoted=4, bonds=30, fetch=90.0)
        ticks[9] = new_tick(209, bonds=5)
        out = self.metrics(ticks)
        self.assertTrue(out["snapshot_ms_per_tick"])
        ph = out["phases"]
        self.assertEqual(ph["ticks_with_phases"], 20)
        self.assertEqual(ph["profiled_ticks"], 20)
        split, brk, other = (ph["by_class"][k] for k in ("split", "break", "other"))
        self.assertEqual((split["ticks"], brk["ticks"], other["ticks"]), (1, 1, 18))
        self.assertEqual(split["physx.fetch_ms"]["p50"], 90.0)
        self.assertEqual(split["stage.corrections"]["max"], 1)
        self.assertEqual(split["zones.correction_ms"]["p50"], 20.0)
        self.assertEqual(ph["split_tick_engine_zones"][0]["zone"], "GpuDestruction.correctedCollisionSolve")
        # controller + submit + fetch + readback + players over dynamics_ms.
        self.assertAlmostEqual(split["named_dynamics_pct"]["p50"], round(100 * 91.65 / 92.0, 1))
        self.assertEqual(ph["collect_us"]["max"], 3.5)
        md = "\n".join(report.phase_md(out))
        self.assertIn("| split | 1 |", md)
        self.assertIn("engine profiler", md)

    def test_a_mixed_file_reads_both_kinds_of_line(self):
        # A capture that spans a server restart is not a thing, but a reader
        # handed old lines beside new ones must not fall over.
        ticks = [dict(OLD_TICK, tick=100 + k, unix_us=1_000_000_000 + k * 16_667) for k in range(3)]
        ticks += [new_tick(103 + k, zones=False) for k in range(3)]
        out = self.metrics(ticks)
        self.assertEqual(out["phases"]["by_class"]["unknown"]["ticks"], 3)
        self.assertEqual(out["phases"]["by_class"]["other"]["ticks"], 3)
        self.assertEqual(out["phases"]["profiled_ticks"], 0)
        self.assertNotIn("zones.submit_ms", out["phases"]["by_class"]["other"])


class FrameClass(unittest.TestCase):
    def test_long_frames_split_by_cause(self):
        fc = report.tick_phases.frame_class
        self.assertEqual(fc(80.0, 60.0, 5.0), "cpu")
        self.assertEqual(fc(80.0, 3.0, 70.0), "gpu")
        self.assertEqual(fc(80.0, 3.0, 6.0), "wait")
        self.assertEqual(fc(80.0, 3.0, None), "unknown")
        self.assertIsNone(report.tick_phases.fnum_or_none(""))
        self.assertIsNone(report.tick_phases.fnum_or_none("nan"))
        self.assertEqual(report.tick_phases.fnum_or_none("6.5"), 6.5)


class Compare(unittest.TestCase):
    def test_deltas(self):
        rows = report.compare({"a": 12.0, "b": None, "c": 5}, {"a": 10.0, "b": 1.0, "c": 0})
        by = {r["metric"]: r for r in rows}
        self.assertEqual(by["a"]["delta"], 2.0)
        self.assertEqual(by["a"]["delta_pct"], 20.0)
        self.assertNotIn("b", by)
        self.assertIsNone(by["c"]["delta_pct"])


if __name__ == "__main__":
    unittest.main()
