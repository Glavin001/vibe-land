#!/usr/bin/env bash
# The wall matrix: impactors (cannonball, meteor, light balls, the monster
# truck) into the lab's structures at every angle and hit point, probed for
# an "effectively infinite wall" (server/src/wall_matrix.rs), judged by
# structures/vehicle-lab/wall-report.mjs.
#
#   scripts/wall-matrix.sh runtime|high [--set all|angles|points|targets|truck] [--scene lab|town] [--trials PREFIXES] [--label NAME] [--jobs N]
#
# Writes target/vehicle-testbed/wall-<profile>-<label>.json and prints the
# verdict table; exit 1 when a case meets an infinite wall. A correctness run:
# it takes a shared GPU slot (VIBE_GPU_SHARED=1, scripts/perf/gpu-run.sh), never
# the exclusive lock. Keep --jobs at 1 (one GPU job per agent). Extra
# environment passes through (what-ifs). The profile is scripts/fidelity/*.env;
# high runs on the integration SDK (HIGH_PHYSX_ROOT, default garage-hifi).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
profile=${1:?usage: wall-matrix.sh runtime|high [--set S] [--trials P] [--label L] [--jobs N]}; shift
set_name=all trials="" label=matrix jobs=1 scene=lab
while [ $# -gt 0 ]; do
  case "$1" in
    --set) set_name="$2"; shift 2 ;;
    --trials) trials="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --scene) scene="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
case $profile in
  runtime) source "$ROOT/scripts/fidelity/runtime.env" ;;
  high) export HIGH_PHYSX_ROOT=${HIGH_PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/.claude/worktrees/hifi/out/install/garage-hifi}
        source "$ROOT/scripts/fidelity/high.env" ;;
  *) echo "profile runtime|high" >&2; exit 2 ;;
esac
"$ROOT/scripts/fidelity/check.sh"
pack=$("$ROOT/scripts/fidelity/packs.sh" "$profile" | sed -n "s/^$scene=//p")
if [ "$scene" = town ]; then export VIBE_TESTBED_SCENE=town; fi
[ -f "$pack" ] || { echo "no $profile lab pack at $pack: scripts/fidelity/build-packs.sh $profile" >&2; exit 1; }
export VIBE_CITY_SCENE="$pack"
out="$ROOT/target/vehicle-testbed"; mkdir -p "$out"
meta="$out/wall-$profile-$label.meta.json"
node "$ROOT/structures/vehicle-lab/wall-matrix.mjs" --pack "$pack" --set "$set_name" --scene "$scene" --out "$meta" > /dev/null
export CARGO_TARGET_DIR="${WALL_TARGET_DIR:-$ROOT/target/wall-$([ "$profile" = high ] && echo hi || echo rt)}"
build=$(cd "$ROOT" && cargo test --release -p web-fps-server --features native-destruction --lib --no-run 2>&1) || { echo "$build" | grep -E '^error' -A12; exit 1; }
bin=$(echo "$build" | sed -n 's/.*Executable unittests src\/lib.rs (\(.*\))/\1/p' | tail -1)
[ -x "$ROOT/$bin" ] || { echo "no test binary in: $build" | tail -5 >&2; exit 1; }
# Every GPU job goes through the machine's admission (the main checkout's
# limiter, shared by worktrees): a shared slot, at most VIBE_GPU_SLOTS at once.
GPU_RUN=${GPU_RUN:-/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh}
[ -x "$GPU_RUN" ] || GPU_RUN="$ROOT/scripts/perf/gpu-run.sh"
export VIBE_GPU_SHARED=1 VIBE_TESTBED_META="$meta" VIBE_TESTBED_CARS=${VIBE_TESTBED_CARS:-monster}
export CUMETAL_CACHE_DIR="${CUMETAL_CACHE_DIR:-$ROOT/target/cumetal-cache-wall}"
# The trial ids, split over `jobs` processes (each one fresh arena per trial).
# Resumable: cases already in this label's reports are not run again
# (WALL_FRESH=1 starts over); each invocation's jobs get a new suffix.
if [ "${WALL_FRESH:-0}" = 1 ]; then rm -f "$out"/wall-$profile-$label-r*.json; fi
run=r$(date +%H%M%S)
ids=$(node -e "
const fs=require('fs');const m=require('$meta');const w='$trials'.split(',').filter(Boolean);
const done=new Set(fs.readdirSync('$out').filter(f=>f.startsWith('wall-$profile-$label-r')&&f.endsWith('.json')).flatMap(f=>{try{return JSON.parse(fs.readFileSync('$out/'+f)).runs.map(r=>r.trial)}catch{return []}}));
console.log(m.trials.map(t=>t.id).filter(id=>(!w.length||w.some(p=>id.startsWith(p)))&&!done.has(id)).join(' '))")
parts=(); for i in $(seq 0 $((jobs - 1))); do parts+=(""); done
k=0; for id in $ids; do parts[$((k % jobs))]+="${parts[$((k % jobs))]:+,}$id\$"; k=$((k + 1)); done
pids=()
for i in $(seq 0 $((jobs - 1))); do
  [ -n "${parts[$i]}" ] || continue
  (cd "$ROOT" && VIBE_TESTBED_TRIALS="${parts[$i]}" VIBE_TESTBED_LABEL="wall-$profile-$label-$run-$i" \
    "$GPU_RUN" "wall-$profile-$label-$i" "$ROOT/$bin" vehicle_testbed --ignored --nocapture --test-threads=1 \
    > "$out/wall-$profile-$label-$run-$i.log" 2>&1) &
  pids+=($!)
done
fail=0; for p in "${pids[@]+"${pids[@]}"}"; do wait "$p" || fail=1; done
[ $fail = 0 ] || { grep -hE 'panicked' -A6 "$out"/wall-$profile-$label-*.log | head -40; echo "wall matrix run FAILED (logs: $out/wall-$profile-$label-*.log)" >&2; }
node "$ROOT/structures/vehicle-lab/wall-report.mjs" --out "$out/wall-$profile-$label.json" "$out"/wall-$profile-$label-r*.json
