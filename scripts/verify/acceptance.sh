#!/bin/bash
# Run the acceptance scenarios' harnesses for one engine profile, then judge.
#   scripts/verify/acceptance.sh runtime|high [OUTDIR] [--skip testbed,veneer,town,wire,walk,node]
# The scenario list and criteria are data in scripts/verify/acceptance.mjs.
# Correctness runs share the GPU (VIBE_GPU_SHARED=1): every GPU harness goes
# through scripts/perf/gpu-run.sh's admission (the test bed, qualification and
# the walk call it themselves), one at a time.
# runtime: the shipping SDK and the default packs. high: the high-fidelity
# profile (scripts/fidelity/high.env) on its SDK, with capabilities that SDK
# lacks dropped and recorded (VIBE_FIDELITY_MISSING), on the high-fidelity
# packs (scripts/fidelity/build-packs.sh high).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
profile=${1:?usage: acceptance.sh runtime|high [OUTDIR] [--skip a,b]}
out=${2:-$ROOT/target/verify/acceptance-$profile}
skip=""
[ "${3:-}" = --skip ] && skip=${4:-}
mkdir -p "$out"
rm -f "$out/acceptance.jsonl"
case $profile in
  runtime) source "$ROOT/scripts/fidelity/runtime.env" ;;
  high) source "$ROOT/scripts/fidelity/high.env"; [ -f "$ROOT/target/fidelity/high/structures/vehicle-lab/out/vehicle-lab-crush.json" ] || "$ROOT/scripts/fidelity/build-packs.sh" high ;;
esac
source "$ROOT/scripts/fidelity/check.sh" --degrade
eval "$("$ROOT/scripts/fidelity/packs.sh" "$profile")"
export VIBE_GPU_SHARED=1
sdk=$(basename "$PHYSX_ROOT")
export CARGO_TARGET_DIR=$ROOT/target/verify-server-$sdk
export QUALIFY_TARGET_DIR=$CARGO_TARGET_DIR
# Stall guard: a harness whose log (or $WATCH) stops growing for VERIFY_STALL_S (default
# 900) s is stuck (an impact solve that never returns, a GPU wait behind another
# process's hung dispatch): kill it and say so in its log.
watched() {
  local log=$1; shift
  "$@" > "$log" 2>&1 &
  local pid=$! last=$(date +%s) size=-1
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    local now=$(date +%s) cur=$(stat -f %z "${WATCH:-$log}" 2>/dev/null || echo 0)
    [ "$cur" != "$size" ] && { size=$cur; last=$now; }
    if [ $(( now - last )) -ge "${VERIFY_STALL_S:-900}" ]; then
      pkill -9 -f "VIBE_TESTBED_LABEL=$label" 2>/dev/null; pkill -9 -P "$pid" 2>/dev/null
      kill -9 "$pid" 2>/dev/null
      echo "STALLED: no output for ${VERIFY_STALL_S:-900} s; killed" >> "$log"
      return 124
    fi
  done
  wait "$pid"
}
want() { [[ ",$skip," != *",$1,"* ]]; }
mark() { # name status
  echo "$2" > "$out/$1.status"; echo "[acceptance] $1: $2"
}
{
  echo "profile=$profile PHYSX_ROOT=$PHYSX_ROOT missing=${VIBE_FIDELITY_MISSING:-none}"
  env | grep -E '^(VIBE_|PX_|TOWN_KIT)' | sort
} > "$out/environment.txt"
t0=$(date +%s)

if want testbed; then
  trials=framed-house,house,cannonball-framed-house,meteor-framed-house,smallshots-framed-house,rest,near-miss,knock-mirror,coast,debris-wheel,drift
  label=verify-acceptance-$profile
  (cd "$ROOT" && VIBE_CITY_SCENE="$lab" VIBE_TESTBED_META="${lab%.json}.meta.json" \
    WATCH="$ROOT/target/vehicle-testbed/$label.log" watched "$out/testbed.log" scripts/vehicle-testbed.sh --build monster --trials "$trials" --label "$label" --report-only)
  cp "$ROOT/target/vehicle-testbed/$label.json" "$out/testbed.json" 2>/dev/null
  cp "$ROOT/target/vehicle-testbed/$label-verdict.json" "$out/testbed-verdict.json" 2>/dev/null
  mark testbed "$([ -f "$out/testbed.json" ] && echo ok || echo "failed (see testbed.log)")"
fi
if want veneer; then
  python3 "$ROOT/scripts/perf/qualify_structures.py" "$veneer"/veneer-bungalow.json "$veneer"/veneer-house.json \
    "$veneer"/veneer-bungalow--frame.json "$veneer"/veneer-house--frame.json \
    "$veneer"/veneer-bungalow--no-front-studs.json "$veneer"/veneer-house--no-front-studs.json \
    "$veneer"/veneer-house--no-ground-front-studs.json --json "$out/qualify-veneer.json" > "$out/qualify-veneer.log" 2>&1
  mark qualify-veneer "$([ -f "$out/qualify-veneer.json" ] && echo ok || echo failed)"
fi
if want lab; then
  # The lab's structures at rest, each alone, counted from tick 0.
  python3 "$ROOT/scripts/perf/qualify_structures.py" "$lab" --json "$out/qualify-lab.json" > "$out/qualify-lab.log" 2>&1
  mark qualify-lab "$([ -f "$out/qualify-lab.json" ] && echo ok || echo failed)"
fi
if want walk; then
  args=("$veneer/veneer-house.json" --json "$out/walk.json")
  [ "${VIBE_PLAYER_SNAP_TO_GROUND:-0}" = 1 ] && args+=(--snap)
  if python3 "$ROOT/scripts/perf/walk_route.py" "${args[@]}" > "$out/walk.log" 2>&1; then mark walk ok
  else mark walk "fails: $(grep -m1 -iE 'panicked|fail|fell|assert' "$out/walk.log" | cut -c1-160)"; fi
fi
if want wire; then
  for t in a_studless_house_collapsing_is_drawn_where_the_server_has_it a_cannonball_hit_is_drawn_where_the_server_has_it; do
    extra=()
    [ "$profile" = high ] && [ "$t" = a_studless_house_collapsing_is_drawn_where_the_server_has_it ] && extra=(VIBE_WIRE_POSE_PACK="$veneer/veneer-house--no-front-studs.json")
    if (cd "$ROOT" && /Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh "verify-wire" env ${extra[@]+"${extra[@]}"} cargo test -q --release -p web-fps-server --features native-destruction --lib "wire_chunk_poses::$t" -- --ignored --exact --nocapture --test-threads=1) > "$out/wire-$t.log" 2>&1
    then mark "wire-$t" "ok: $(grep -m1 -iE 'worst' "$out/wire-$t.log" | cut -c1-120)"
    else mark "wire-$t" "fails: $(grep -m1 -E 'panicked|worst' -A1 "$out/wire-$t.log" | tr '\n' ' ' | cut -c1-200)"; fi
  done
fi
if want node; then
  if (cd "$ROOT" && node --test client/native/film/*.test.mjs) > "$out/driving-tests.log" 2>&1; then mark driving-tests ok; else mark driving-tests "fails (see driving-tests.log)"; fi
fi
if want town; then
  python3 "$ROOT/scripts/perf/qualify_structures.py" "$town" --json "$out/qualify-town.json" > "$out/qualify-town.log" 2>&1
  mark qualify-town "$([ -f "$out/qualify-town.json" ] && echo ok || echo failed)"
fi
echo "[acceptance] harnesses took $(( $(date +%s) - t0 )) s"
node "$ROOT/scripts/verify/acceptance.mjs" judge "$profile" "$out"
