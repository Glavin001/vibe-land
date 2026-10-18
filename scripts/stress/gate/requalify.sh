#!/bin/bash
# Flag-on correctness runs, concurrent on a shared GPU (correctness, not
# timing): Vibe Town (real capacities) and the veneer houses qualified at rest
# with section rotation, and the vehicle fleet's rotation arm.
#   OUT=target/stress-gate LABEL=rot scripts/stress/gate/requalify.sh [town] [veneer] [fleet]
set -u
cd "$(dirname "$0")/../../.."
OUT=${OUT:-target/stress-gate}; LABEL=${LABEL:-rot}; mkdir -p "$OUT"
export VIBE_GPU_SHARED=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1 VIBE_SECTION_ROTATION=1
export PHYSX_ROOT=${PHYSX_ROOT:-/Users/glavin/Development/PhysX/out/install/garage-multihull}
export QUALIFY_TARGET_DIR=${QUALIFY_TARGET_DIR:-$PWD/target/section-rotation-qualify}
what=${*:-town veneer fleet}
pids=()
for w in $what; do
  case $w in
    town) python3 scripts/perf/qualify_structures.py structures/vibe-town/out/vibe-town-real.json \
            --json "$OUT/town-real-$LABEL.json" > "$OUT/town-real-$LABEL.log" 2>&1 & pids+=($!) ;;
    veneer) VIBE_QUALIFY_FRONT_DROP=1 node structures/town-kit/scripts/qualify-veneer-houses.mjs \
            > "$OUT/veneer-$LABEL.log" 2>&1 & pids+=($!) ;;
    fleet) CARGO_TARGET_DIR=$PWD/target/section-rotation-fleet2 scripts/vehicle-testbed.sh \
            --label "srs-$LABEL" --report-only > "$OUT/fleet-$LABEL.log" 2>&1 & pids+=($!) ;;
  esac
  sleep 5
done
wait "${pids[@]}"
echo "done: $what"
