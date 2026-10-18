#!/usr/bin/env python3
"""Run one perf-suite job under lldb, printing a backtrace at every CuMetal host wait.

  VIBE_GPU_SHARED=1 scripts/perf/gpu-run.sh lldb python3 scripts/perf/lldb_suite_job.py RUN_DIR SCENE OUT.log

RUN_DIR is a suite run (target/perf-suite/runs/<run>); the job runs in the environment
its work.json gave it. The command file scripts/perf/lldb-wait-stacks.cmds breaks on
CuMetal's wait_ticket and prints `bt 16`. The SUITE_TICK lines in OUT.log close each
tick, so the stacks before a correction tick's line (passes 2) are that tick's waits.
This is for attribution only: lldb makes every wait slow, so run it on a shared slot.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/perf"))
import suite  # noqa: E402

run_dir, scene, out = sys.argv[1:4]
work = json.loads((Path(run_dir) / "work.json").read_text())
job = next(j for j in work["jobs"]["runtime"] if j["scene"] == scene)
env = suite.job_env(job, work["profile_env"], work["extra_env"]["runtime"])
cmd = ["lldb", "--batch", "-s", str(ROOT / "scripts/perf/lldb-wait-stacks.cmds"), "--", work["binaries"]["runtime"],
       "perf_suite::perf_suite", "--exact", "--ignored", "--nocapture", "--test-threads=1"]
with open(out, "w") as f:
    sys.exit(subprocess.run(cmd, cwd=ROOT / "server", env=env, stdout=f, stderr=subprocess.STDOUT).returncode)
