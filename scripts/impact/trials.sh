#!/bin/bash
# The impact solve's lab trials (vehicle test bed) on the garage-impact SDK,
# sharing the GPU (correctness, not timing).
#
#   scripts/impact/trials.sh LABEL TRIALS [ENV=VAL ...]
#
# e.g. scripts/impact/trials.sh E-house framed-house,framed-house-corner VIBE_IMPACT_CAPACITY=1
# Writes target/vehicle-testbed/LABEL.{out,log,json}. PX_DESTRUCTION_ALLOW_UNCONVERGED=1
# as the product sets it. PHYSX_ROOT and CARGO_TARGET_DIR may be overridden.
label=$1; trials=$2; shift 2
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p target/vehicle-testbed
env VIBE_GPU_SHARED=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1 \
  PHYSX_ROOT="${PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-impact}" \
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target/impact-e}" "$@" \
  scripts/vehicle-testbed.sh --build monster --trials "$trials" --label "$label" --report-only > "target/vehicle-testbed/$label.out" 2>&1
echo "EXIT $?" >> "target/vehicle-testbed/$label.out"
