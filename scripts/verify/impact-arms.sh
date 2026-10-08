#!/bin/bash
# The impact comparison: the high profile (static solve plus the explicit
# impact step) and arm A (the static solve only), repeated, on the physics gates.
#   scripts/verify/impact-arms.sh [--arms high,high-static] [--trials a,b] [--repeats 3] [--jobs 2] [--judge-only] [OUTDIR]
# Identical runs can end local or in a collapse (the rigid simulation is not
# bitwise repeatable on the GPU), so each trial runs --repeats times (at least 3)
# per arm. Each run is one trial in its own process (acceptance.sh, the test
# bed only, behind the provenance check, on the shared GPU slot), with
# VIBE_TESTBED_EARLY_END=1: the trial ends once its outcome is decided.
# Runs land in OUTDIR/ARM/TRIAL-rK; impact-arms.mjs then counts local vs
# collapse and the gates per trial and arm, beside the cached arm C where an
# entry exists (scripts/verify/ground-truth; arm C is retired, a reference only).
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
arms=high,high-static
trials=cannonball-framed-house,meteor-framed-house-roof,meteor-framed-house-upper,smallshots-framed-house,framed-house,framed-house-corner
repeats=3 judge_only=0 jobs=2 one_run=0 out=$ROOT/target/verify/impact-arms
while [ $# -gt 0 ]; do
  case $1 in
    --jobs) jobs=$2; shift 2 ;;
    --one-out) out=$2; shift 2 ;;
    --one) one_run=1; one_args=("$2" "$3" "$4"); shift 4 ;;
    --arms) arms=$2; shift 2 ;;
    --trials) trials=$2; shift 2 ;;
    --repeats) repeats=$2; shift 2 ;;
    --judge-only) judge_only=1; shift ;;
    *) out=$1; shift ;;
  esac
done
[ "$one_run" = 1 ] || [ "$repeats" -ge 3 ] || echo "[arms] warning: $repeats repeats; outcomes bifurcate, 3 is the least that says how often"
[ "$one_run" = 1 ] || mkdir -p "$out"
export PX_DESTRUCTION_ALLOW_UNCONVERGED=1 PX_DESTRUCTION_IMPACT_LOG=1 VIBE_TESTBED_EARLY_END=1
# Until the high profile's SDK is current again (bounded: 20 min).
wait_current() {
  local end=$((SECONDS + 1200))
  echo "[arms] the SDK is stale: waiting for sdk-follow.sh's rebuild"
  while [ $SECONDS -lt $end ]; do
    sleep 30
    (source "$ROOT/scripts/fidelity/high.env"; export PHYSX_ROOT=$(cd -P "$PHYSX_ROOT" && pwd); "$ROOT/scripts/fidelity/provenance.sh" high > /dev/null 2>&1) && return 0
  done
  return 1
}
# One run (the workers call the script back with --one ARM TRIAL K).
one() {
  local arm=$1 trial=$2 k=$3 dir=$out/$1/$2-r$3 t0
  [ -f "$out/.refused" ] && return 0
  [ -f "$dir/testbed.json" ] && { echo "[arms] $arm $trial r$k: done before"; return 0; }
  mkdir -p "$out/$arm"; t0=$(date +%s)
  VERIFY_TRIALS="$trial\$" VERIFY_LABEL="impact-arms-$arm-$trial-r$k" "$ROOT/scripts/verify/acceptance.sh" "$arm" "$dir" \
    --skip veneer,lab,town,wire,walk,node > "$dir.log" 2>&1 || echo "[arms] $arm $trial r$k: acceptance exited non-zero ($dir.log)"
  grep -E "refused|NOT IN THIS SDK" "$dir.log" | sed "s/^/[arms] $arm: /"
  if grep -q "\[acceptance\] refused" "$dir.log"; then
    # A branch moved: sdk-follow.sh rebuilds within minutes. Wait for a current
    # SDK (up to 20 min), then run this one again; stop the queue only past that.
    rm -rf "$dir"
    if [ "${4:-0}" = 0 ] && wait_current; then one "$arm" "$trial" "$k" 1; return $?; fi
    touch "$out/.refused"; echo "[arms] stopping: the provenance check refused for 20 min (is sdk-follow.sh running?)"; return 1
  fi
  echo "[arms] $arm $trial r$k: $(( $(date +%s) - t0 )) s"
}
if [ "$one_run" = 1 ]; then one "${one_args[@]}"; exit $?; fi
if [ "$judge_only" = 0 ]; then
  # --jobs workers (default 2), each run its own shared-slot GPU job (gpu-run.sh
  # caps the machine at 3, so other agents still get one).
  rm -f "$out/.refused"
  for k in $(seq 1 "$repeats"); do for trial in ${trials//,/ }; do for arm in ${arms//,/ }; do echo "$arm $trial $k"; done; done; done \
    | xargs -P "$jobs" -L 1 "$0" --one-out "$out" --one
  [ -f "$out/.refused" ] && exit 1
fi
eval "$("$ROOT/scripts/fidelity/packs.sh" high)"
runs=()
for arm in ${arms//,/ }; do for d in "$out/$arm"/*-r*/; do [ -f "$d/testbed.json" ] && runs+=("$arm=$d"); done; done
node "$ROOT/scripts/verify/impact-arms.mjs" --pack "$lab" --meta "${lab%.json}.meta.json" --trials "$trials" \
  --truth "$ROOT/scripts/verify/ground-truth" --out "$out/impact-arms.json" ${runs[@]+"${runs[@]}"} | tee "$out/impact-arms.txt"
