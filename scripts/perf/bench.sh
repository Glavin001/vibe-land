#!/usr/bin/env bash
# THE perf command. One invocation -> the full scenario matrix, each printed as
# a hierarchical budget whose percentages add up, plus a coverage figure that
# proves it. Designed so the output can be pasted verbatim into a report and so
# two runs can be compared with zero ambiguity about what was measured.
#
#   scripts/perf/bench.sh --label base              # record a labelled set
#   scripts/perf/bench.sh --label mychange          # record another
#   scripts/perf/bench.sh --ab base mychange        # matched comparison
#   scripts/perf/bench.sh --show base               # re-print, no re-run
#   scripts/perf/bench.sh --label x --quick         # grid 1, ~2 min total
#
# WHY THIS EXISTS AS ONE SCRIPT. Every wrong perf conclusion in this project
# came from a measurement defect, and each one was a caller reconstructing
# setup by hand:
#   * profile.sh restated the physics env inline and dropped two BLAST_* flags,
#     so hw_bond ran the CPU walk at 10.3 ms (14.5x the real cost) and the
#     "idle" city broke 49,832 bonds with nobody shooting. Sourcing, not
#     restating, is why physics-env.sh exists.
#   * run-vl4-server.sh launches a HARDLINK, web-fps-server-vl4. A rebuild
#     replaces the inode behind it, so the server can silently be a binary
#     from hours earlier -- observed as a 2.3x "regression" that was really a
#     stale deploy. This script fingerprints the binary it actually ran.
# So: nothing here is optional and nothing is restated. If you need a knob,
# add it to physics-env.sh, which is the single source of truth.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT=$PWD
OUTROOT=bench-results/perf

SCENE=destruction/assets/scenes/fractured-downtown.json
GRID=2 SECONDS_RUN=70 WARMUP=600 LABEL="" MODE=run
SCENARIOS="$(python3 "$(dirname "${BASH_SOURCE[0]}")/scenarios.py" default)"
while [ $# -gt 0 ]; do
  case "$1" in
    --label)     LABEL=$2; shift 2;;
    --grid)      GRID=$2; shift 2;;
    --seconds)   SECONDS_RUN=$2; shift 2;;
    --scenarios) SCENARIOS=$2; shift 2;;
    --scene)     SCENE=$2; shift 2;;
    --warmup)    WARMUP=$2; shift 2;;
    --quick)     GRID=1; SECONDS_RUN=25; WARMUP=300; QUICK=1; shift;;
    --ab)        MODE=ab; shift;;
    --show)      MODE=show; shift;;
    *) break;;
  esac
done

# Scenarios are DECLARED in scripts/perf/scenarios.py -- name, knobs, the
# hypothesis each one tests, and the assertions that prove the run reached that
# regime. One source of truth: this script asks for knobs, bench_report.py asks
# for intent. Do not add a scenario here.

if [ "$MODE" = ab ]; then
  A=${1:-}; B=${2:-}
  [ -z "$B" ] && { echo "usage: bench.sh --ab BASE_LABEL NEW_LABEL"; exit 1; }
  exec python3 scripts/perf/bench_report.py --ab "$OUTROOT/$A" "$OUTROOT/$B" \
       --warmup="$WARMUP"
fi
if [ "$MODE" = show ]; then
  L=${1:-}
  [ -z "$L" ] && { echo "usage: bench.sh --show LABEL"; exit 1; }
  exec python3 scripts/perf/bench_report.py --show "$OUTROOT/$L" --warmup="$WARMUP"
fi

[ -z "$LABEL" ] && { echo "REFUSING: --label is required so a run can be"; \
  echo "  compared later without guessing what it was. e.g. --label base"; exit 1; }

# 1. Nothing else may hold the GPU. Tracing beside a live CUDA context
#    inflated the tail ~60x (cb_max p99.9 63,307 us vs 1,039).
if pgrep -f "[w]eb-fps-server-vl4" > /dev/null; then
  echo "REFUSING: the vl4 server is running and holds a CUDA context."
  echo "  Stop it first:"
  echo "    for p in \$(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print \$1}'); do kill \$p; done"
  echo "    kill \$(pgrep -f '[w]eb-fps-server-vl4')"
  echo "  NOT 'pkill -x web-fps-server-vl4': -x matches the process NAME, which"
  echo "  the kernel truncates to 15 chars, so it silently matches nothing --"
  echo "  and 'pgrep -x' fails identically, reporting the server as stopped"
  echo "  when it is still up and still holding the GPU."
  exit 1
fi

# 2. The feature set that measures the real solver. 'destruction' alone
#    compiles the CUDA solver OUT and the CPU residual reads as real stress.
echo "== building (cuda-stress,blast-core)"
cargo build --release -p web-fps-server --features cuda-stress,blast-core \
  2>&1 | grep -E "^error" && exit 1

# 3. Physics env: SOURCE it, never restate it.
export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
# shellcheck source=../physics-env.sh
. "$ROOT/scripts/physics-env.sh"
export VIBE_CITY_GRID="$GRID"

DEST="$OUTROOT/$LABEL"
rm -rf "$DEST"; mkdir -p "$DEST"

# 4. Fingerprint what we are ACTUALLY running, so a stale binary or a stray
#    env override can never be mistaken for a code change.
BIN=./target/release/record-city-trace
python3 - "$DEST/meta.json" "$BIN" "$GRID" "$SCENE" "$SECONDS_RUN" "$SCENARIOS" <<'PY'
import json, os, subprocess, sys
dest, binp, grid, scene, secs, scen = sys.argv[1:7]
st = os.stat(binp)
git = subprocess.run(["git","describe","--always","--dirty"],
                     capture_output=True, text=True).stdout.strip()
env = {k: v for k, v in os.environ.items()
       if k.startswith(("VIBE_", "BLAST_")) }
json.dump({"git": git, "binary": binp, "binary_mtime_unix": int(st.st_mtime),
           "binary_inode": st.st_ino, "binary_size": st.st_size,
           "grid": int(grid), "scene": scene, "seconds": int(secs),
           "scenarios": scen.split(","), "env": env},
          open(dest, "w"), indent=2, sort_keys=True)
PY

IFS=',' read -ra SCN <<< "$SCENARIOS"
for s in "${SCN[@]}"; do
  read -r shots interval secs _warm < <(python3 scripts/perf/scenarios.py args "$s") \
    || { echo "unknown scenario: $s"; exit 1; }
  # --seconds on the command line overrides the declaration only when the
  # caller asked for a shorter sweep (--quick); otherwise the scenario owns it,
  # because its regime assertions were calibrated against that duration.
  [ -n "${QUICK:-}" ] && secs=$SECONDS_RUN
  echo "== $LABEL/$s   grid=$GRID ${secs}s shots=$shots every=${interval}t"
  ARGS=(--scene "$SCENE" --grid "$GRID" --seconds "$secs" --shots "$shots"
        --targets 27 --output /dev/null --metrics-out "$DEST/$s.csv")
  [ "$interval" -gt 0 ] && ARGS+=(--shot-interval-ticks "$interval")
  "$BIN" "${ARGS[@]}" > "$DEST/$s.log" 2>&1 \
    || { echo "FAIL: $s did not complete, see $DEST/$s.log"; exit 1; }
  # The scene's live bond total is printed by the trace binary; capture it so
  # the report can express damage as a FRACTION rather than a bare count.
  grep -oP 'bonds \K[0-9]+' "$DEST/$s.log" | head -1 > "$DEST/$s.bonds" || true
done

exec python3 scripts/perf/bench_report.py --show "$DEST" --warmup="$WARMUP"
