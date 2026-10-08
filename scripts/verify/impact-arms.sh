#!/bin/bash
# The impact comparison: the high profile (static solve plus the explicit
# impact step) and arm A (the static solve only), repeated, on the physics gates.
#   scripts/verify/impact-arms.sh [--arms high,high-static] [--trials a,b] [--repeats 3] [--judge-only] [OUTDIR]
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
repeats=3 judge_only=0 out=$ROOT/target/verify/impact-arms
while [ $# -gt 0 ]; do
  case $1 in
    --arms) arms=$2; shift 2 ;;
    --trials) trials=$2; shift 2 ;;
    --repeats) repeats=$2; shift 2 ;;
    --judge-only) judge_only=1; shift ;;
    *) out=$1; shift ;;
  esac
done
[ "$repeats" -ge 3 ] || echo "[arms] warning: $repeats repeats; outcomes bifurcate, 3 is the least that says how often"
mkdir -p "$out"
export PX_DESTRUCTION_ALLOW_UNCONVERGED=1 PX_DESTRUCTION_IMPACT_LOG=1 VIBE_TESTBED_EARLY_END=1
if [ "$judge_only" = 0 ]; then
  for k in $(seq 1 "$repeats"); do
    for trial in ${trials//,/ }; do
      for arm in ${arms//,/ }; do
        dir=$out/$arm/$trial-r$k
        [ -f "$dir/testbed.json" ] && { echo "[arms] $arm $trial r$k: done before"; continue; }
        mkdir -p "$out/$arm"; t0=$(date +%s)
        VERIFY_TRIALS=$trial VERIFY_LABEL="impact-arms-$arm-$trial-r$k" "$ROOT/scripts/verify/acceptance.sh" "$arm" "$dir" \
          --skip veneer,lab,town,wire,walk,node > "$dir.log" 2>&1 || echo "[arms] $arm $trial r$k: acceptance exited non-zero ($dir.log)"
        grep -E "refused|NOT IN THIS SDK" "$dir.log" | sed "s/^/[arms] $arm: /"
        echo "[arms] $arm $trial r$k: $(( $(date +%s) - t0 )) s"
      done
    done
  done
fi
eval "$("$ROOT/scripts/fidelity/packs.sh" high)"
runs=()
for arm in ${arms//,/ }; do for d in "$out/$arm"/*-r*/; do [ -f "$d/testbed.json" ] && runs+=("$arm=$d"); done; done
node "$ROOT/scripts/verify/impact-arms.mjs" --pack "$lab" --meta "${lab%.json}.meta.json" --trials "$trials" \
  --truth "$ROOT/scripts/verify/ground-truth" --out "$out/impact-arms.json" "${runs[@]}" | tee "$out/impact-arms.txt"
