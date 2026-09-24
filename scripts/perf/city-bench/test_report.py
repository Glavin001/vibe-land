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
