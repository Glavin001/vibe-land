#!/bin/bash
# The performance suite: one score for "how good is our performance", per
# engine profile (headline: high fidelity), against a stored baseline.
#
#   scripts/perf/suite.sh                    standard tier (~60-120 s inside the GPU lock)
#   scripts/perf/suite.sh --quick            quick tier (~60 s)
#   scripts/perf/suite.sh --reps 3 --save-baseline     record the baseline (scripts/perf/suite-baseline.json)
#   scripts/perf/suite.sh --compare OTHER/report.json  deltas against another run, with significance
#   scripts/perf/suite.sh --report RUN_DIR             re-read a run (no GPU)
#   scripts/perf/suite.sh --capture                    (once) the impact captures the high profile replays
#
# Scenarios are data: scripts/perf/suite.json. Harness: server/src/perf_suite.rs.
# Timing takes the exclusive GPU lock (scripts/perf/gpu-run.sh, no
# VIBE_GPU_SHARED): it waits for running shared jobs, then holds the GPU for
# the whole timed part. Correctness is scripts/verify/correctness.sh; an
# optimisation must improve this score without breaking that.
# See docs/perf/SUITE.md.
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/suite.py" "$@"
