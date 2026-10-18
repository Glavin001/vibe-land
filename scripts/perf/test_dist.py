"""Regression gates for reports used to choose simulation optimizations."""
import csv
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("dist.py")


class Reports(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.trace = Path(self.temp.name) / "trace.csv"
        with self.trace.open("w") as f:
            writer = csv.DictWriter(f, fieldnames=["tick", "awake", "bodies", "bonds",
                "physx_step", "stress_solve", "post_step", "resim"])
            writer.writeheader()
            for tick in range(41):
                writer.writerow(dict(tick=tick, awake=100, bodies=100, bonds=100,
                    physx_step=1, stress_solve=3, post_step=5, resim=20))

    def run_report(self, *args, success=True):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.trace), *args],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0 if success else 2, result.stderr)
        return result.stdout + result.stderr

    def test_warmup_both_spellings_and_boundary(self):
        a = self.run_report("--warmup", "20", "--by", "none", "--spikes", "0")
        b = self.run_report("--warmup=20", "--by=none", "--spikes=0")
        self.assertEqual(a, b)
        self.assertIn("41 ticks, 21 excluded", a)
        self.assertIn("20 analysed", a)
        self.assertIn("total p50 29.00 ms", a)

    def test_measured_wall_time_is_not_replaced_by_partial_brackets(self):
        with self.trace.open() as f:
            rows = list(csv.DictReader(f))
        with self.trace.open("w") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]) + ["sim"])
            writer.writeheader()
            for row in rows:
                writer.writerow(dict(row, sim=31))
        out = self.run_report("--warmup", "20", "--by", "none", "--spikes", "0")
        self.assertIn("total p50 31.00 ms", out)
        tree = self.run_report("--tree", "--warmup", "20", "--by", "none")
        self.assertRegex(tree, r"TOTAL\s+31.00")

    def test_default_warmup(self):
        self.assertIn("41 excluded", self.run_report())

    def test_replay_determines_spike_order(self):
        with self.trace.open("a") as f:
            f.write("41,100,100,100,2,3,5,50\n")
            f.write("42,100,100,100,9,3,5,0\n")
        out = self.run_report("--warmup", "20", "--by", "none", "--spikes", "1")
        spike = out.split("worst ticks by total", 1)[1]
        self.assertRegex(spike, r"tick\s+41 total\s+60.00")

    def test_ab_includes_total_and_supports_unbucketed(self):
        out = self.run_report(str(self.trace), "--ab", "--warmup", "20", "--by", "none")
        self.assertRegex(out, r"TOTAL\s+29.00\s+29.00\s+0.0%")

    def test_empty_tree_is_reported(self):
        self.assertIn("0 ticks analysed", self.run_report("--tree", "--by", "none"))

    def test_empty_ab_is_reported(self):
        self.assertIn("no comparison", self.run_report(str(self.trace), "--ab"))

    def test_tree_uses_same_total(self):
        out = self.run_report("--tree", "--warmup", "20", "--by", "none")
        self.assertRegex(out, r"TOTAL\s+29.00")

    def test_invalid_options_fail_clearly(self):
        for args in [("--warmup",), ("--warmup", "-1"), ("--spikes", "-1"),
                     ("--ab",), ("--tree", "--ab")]:
            with self.subTest(args=args):
                self.assertIn("error:", self.run_report(*args, success=False))


if __name__ == "__main__":
    unittest.main()
