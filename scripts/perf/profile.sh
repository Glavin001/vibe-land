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
  # 2. Physics env, matching the live server. SOURCE it -- do not restate it.
  # This block used to inline a partial copy and silently omitted the two
  # BLAST_* flags, so the profile measured a scene production never runs:
  # BLAST_BOND_STRESS_GPU unset put hw_bond on the serial CPU walk (10.3 ms
  # flat vs 0.2 ms), and BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY unset let the
  # grid-2 city tear itself apart at rest (49,832 bonds broken with 0 shots).
  # That is the exact drift physics-env.sh was created to end.
  export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
  # shellcheck source=../physics-env.sh
  . "$(dirname "${BASH_SOURCE[0]}")/../physics-env.sh"
  export VIBE_CITY_GRID="$GRID"
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
