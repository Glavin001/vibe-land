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
