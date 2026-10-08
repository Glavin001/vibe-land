#!/bin/bash
# The impact-arm comparison: the shots on each arm of the high profile, then a
# side-by-side table against arm C (scripts/verify/impact-arms.mjs).
#   scripts/verify/impact-arms.sh [--arms static,step,oracle] [--trials a,b] [--judge-only] [OUTDIR]
# Arms (scripts/fidelity/arms/*.env, select.sh):
#   static  A: the static solve only (VIBE_IMPACT_CAPACITY=0)
#   step    B: static plus the linear impact step (VIBE_IMPACT_STEP=1)
#   oracle  C: the ADMM impact solve at its correctness budget, the reference
# Each arm is scripts/verify/acceptance.sh high-ARM (the test bed only, its shot
# trials), one after another, each GPU job through gpu-run.sh's shared slot.
# An arm the bridge or SDK cannot run is skipped and says why.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
arms=static,step,oracle
trials=cannonball-framed-house,meteor-framed-house,meteor-framed-house-roof,meteor-framed-house-upper
judge_only=0 out=$ROOT/target/verify/impact-arms
while [ $# -gt 0 ]; do
  case $1 in
    --arms) arms=$2; shift 2 ;;
    --trials) trials=$2; shift 2 ;;
    --judge-only) judge_only=1; shift ;;
    *) out=$1; shift ;;
  esac
done
mkdir -p "$out"
export PX_DESTRUCTION_ALLOW_UNCONVERGED=1 PX_DESTRUCTION_IMPACT_LOG=1
pairs=()
for arm in ${arms//,/ }; do
  dir=$out/high-$arm
  if [ "$arm" = step ] && ! grep -rq VIBE_IMPACT_STEP "$ROOT/physx-bridge/src"; then
    echo "[arms] step: skipped, the bridge does not read VIBE_IMPACT_STEP yet (the impact step is not merged)"; continue
  fi
  if [ "$judge_only" = 0 ]; then
    echo "[arms] $arm: running $trials"
    VERIFY_TRIALS=$trials "$ROOT/scripts/verify/acceptance.sh" "high-$arm" "$dir" --skip veneer,lab,town,wire,walk,node > "$out/$arm.log" 2>&1 \
      || echo "[arms] $arm: acceptance exited non-zero (see $out/$arm.log)"
    grep -E "^\[fidelity\] NOT IN THIS SDK|refused" "$out/$arm.log" | sed "s/^/[arms] $arm: /"
  fi
  pairs+=("$arm=$dir")
done
eval "$("$ROOT/scripts/fidelity/packs.sh" high)"
node "$ROOT/scripts/verify/impact-arms.mjs" --pack "$lab" --meta "${lab%.json}.meta.json" --trials "$trials" --out "$out/impact-arms.json" "${pairs[@]}" | tee "$out/impact-arms.txt"
