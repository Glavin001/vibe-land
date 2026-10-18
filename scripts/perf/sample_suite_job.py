#!/usr/bin/env python3
"""CPU-sample one perf-suite job with macOS `sample`, in the exact environment the suite gave it.

  scripts/perf/gpu-run.sh sample python3 scripts/perf/sample_suite_job.py RUN_DIR SCENE OUT [--delay S] [--seconds N] [--profile runtime]

RUN_DIR is a suite run (target/perf-suite/runs/<run>). The job's environment comes from
its work.json; SCENE is one of its jobs, for example lab-truck or town. The script writes
OUT.log (the job's output) and OUT.txt (the call tree). Start it under the GPU lock.
Read OUT.txt with sample's own summary, or keep only the stacks inside the physics step
(see README-cumetal-trace.md). With a 1 ms interval a 30 ms correction tick yields about
30 samples, so merge several runs before ranking anything small.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/perf"))
import suite  # noqa: E402

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("run_dir")
ap.add_argument("scene")
ap.add_argument("out")
ap.add_argument("--profile", default="runtime")
ap.add_argument("--delay", type=float, default=0.5, help="seconds before sampling starts")
ap.add_argument("--seconds", default="30", help="sampling length (the sample ends with the process)")
args = ap.parse_args()

work = json.loads((Path(args.run_dir) / "work.json").read_text())
job = next(j for j in work["jobs"][args.profile] if j["scene"] == args.scene)
env = suite.job_env(job, work["profile_env"], work["extra_env"][args.profile])
with open(args.out + ".log", "w") as log:
    proc = subprocess.Popen([work["binaries"][args.profile], "perf_suite::perf_suite", "--exact", "--ignored",
                             "--nocapture", "--test-threads=1"], cwd=ROOT / "server", env=env, stdout=log,
                            stderr=subprocess.STDOUT)
    time.sleep(args.delay)
    subprocess.run(["sample", str(proc.pid), args.seconds, "1", "-mayDie", "-file", args.out + ".txt"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.exit(proc.wait())
