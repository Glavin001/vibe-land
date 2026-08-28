#!/usr/bin/env bash
# One command for the timing budget. Everything this session learned the hard
# way is encoded here so it does not have to be remembered again.
#
#   scripts/perf/profile.sh                    # default: downtown grid 2
#   scripts/perf/profile.sh --grid 1           # smaller scene
#   scripts/perf/profile.sh --idle             # at rest, no shots
#   scripts/perf/profile.sh --reuse LAST.csv   # re-analyse, do not re-run
#   scripts/perf/profile.sh --ab A.csv B.csv   # compare two runs
#
# The traps it handles for you:
#   1. The deployed server holds a CUDA context. Tracing beside it inflated
#      the tail 60x (cb_max p99.9 63,307 us vs 1,039). This REFUSES to run
#      while it is up rather than quietly producing a worse number.
#   2. Physics env must match run-vl4-server.sh or the scene behaves
#      differently and the numbers describe a game nobody plays.
#   3. Ring warm-up must be excluded; a mean including it once read 0.295 ms
#      identically across five different scenes.
#   4. --features cuda-stress,blast-core, or you measure the CPU solver and
#      the city eats itself.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT=$PWD

SCENE=destruction/assets/scenes/fractured-downtown.json
GRID=2 SECONDS_RUN=70 SHOTS=45 WARMUP=600 OUT=""
REUSE="" AB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scene) SCENE=$2; shift 2;;
    --grid) GRID=$2; shift 2;;
    --seconds) SECONDS_RUN=$2; shift 2;;
    --shots) SHOTS=$2; shift 2;;
    --idle) SHOTS=0; shift;;
    # Directional answers do not need 87k chunks and 55 s. --quick is grid 1
    # for 25 s: ~40 s end to end against ~5 min for a grid-2 A/B set. Use it
    # for "did that move at all", and the full run only for numbers you are
    # going to quote.
    --quick) GRID=1; SECONDS_RUN=25; SHOTS=15; WARMUP=300; shift;;
    --warmup) WARMUP=$2; shift 2;;
    --reuse) REUSE=$2; shift 2;;
    --ab) AB=1; shift;;
    *) break;;
  esac
done

if [ -n "$AB" ]; then
  exec python3 scripts/perf/dist.py "$1" "$2" --ab --warmup="$WARMUP"
fi

if [ -z "$REUSE" ]; then
  # 1. Nothing else may hold the GPU.
  if pgrep -f "[w]eb-fps-server-vl4" > /dev/null; then
    echo "REFUSING: the vl4 server is running and holds a CUDA context."
    echo "  Tracing beside it inflates the tail ~60x. Stop it first:"
    echo "    for p in \$(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print \$1}'); do kill \$p; done"
    echo "    for p in \$(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print \$1}'); do kill \$p; done"
    exit 1
  fi
  # 4. The feature set that measures the real solver.
  echo "== building (cuda-stress,blast-core)"
  cargo build --release -p web-fps-server --features cuda-stress,blast-core \
    2>&1 | grep -E "^error" && exit 1
  # 2. Physics env, matching the live server.
  export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
  export VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32
  export VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02
  export VIBE_CITY_STRESS_LIMIT_SCALE=0.45
  export VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7
  OUT="${TMPDIR:-/tmp}/cityprof-$(date -u +%Y%m%d-%H%M%S)-g${GRID}-s${SHOTS}.csv"
  echo "== tracing  scene=$(basename "$SCENE") grid=$GRID ${SECONDS_RUN}s shots=$SHOTS"
  ./target/release/record-city-trace \
    --scene "$SCENE" --grid "$GRID" --seconds "$SECONDS_RUN" \
    --shots "$SHOTS" --targets 27 --output /dev/null --metrics-out "$OUT" \
    > "${OUT%.csv}.log" 2>&1 || { echo "FAIL: trace did not complete, see ${OUT%.csv}.log"; exit 1; }
  head -1 "${OUT%.csv}.log"
else
  OUT="$REUSE"
fi

echo
python3 scripts/perf/dist.py "$OUT" --tree --warmup="$WARMUP"
echo
python3 scripts/perf/dist.py "$OUT" --warmup="$WARMUP" --spikes=5 \
  | sed -n '/worst ticks/,$p'
echo
echo "csv: $OUT"
echo "re-analyse without re-running:  scripts/perf/profile.sh --reuse $OUT"
