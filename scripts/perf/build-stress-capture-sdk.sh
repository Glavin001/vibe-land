#!/bin/bash
# Build the stress-problem capture SDK: a copy of the installed garage SDK
# (../PhysX/out/install/garage-multihull) whose destruction runtime is the
# diagnostic PhysXDestructionGpuProblemDiagnostic build, installed beside it as
# ../PhysX/out/install/garage-multihull-stress-problem. Select it with
# PHYSX_ROOT and a separate CARGO_TARGET_DIR; the production SDK is untouched.
#
#   scripts/perf/build-stress-capture-sdk.sh       # ~2-3 min after a stress-solver change
#
# The diagnostic runtime writes each selected solve's exact system, its final
# iterate and per-iteration history (blast .../detail/StressProblemCapture.cuh),
# read by scripts/stress/oracle.py. Its timings are not production timings.
# Run rebuild-garage-sdk.sh first when PhysX changed outside the stress solver.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PHYSX=$(cd "$ROOT/../PhysX" && pwd)
CUMETAL=$(cd "$ROOT/../cuda-metal" && pwd)
NAME=${GARAGE_SDK_NAME:-garage-multihull}
BASE="$PHYSX/out/install/$NAME"
OVERLAY="$BASE-stress-problem"
OPTS=(--preset macos-cumetal --generator 'Unix Makefiles' --jobs 8
  --build-root "$PHYSX/out/build/$NAME" --install-prefix "$BASE"
  --cumetal-rigid-demo --cumetal-explicit-aggregate-root --cumetal-explicit-motion-root
  --cumetal-explicit-hierarchy-root --cumetal-pack-bond-stress-scalars --cumetal-block-voted-traps
  --cumetal-particle-inline-threshold 500 --cumetal-softbody-inline-threshold 500)
[ -f "$BASE/sdk-artifacts.json" ] || { echo "no installed SDK at $BASE; run rebuild-garage-sdk.sh" >&2; exit 1; }
cd "$PHYSX"
python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage gpu --target PhysXDestructionGpuProblemDiagnostic
rm -rf "$OVERLAY"
cp -R "$BASE" "$OVERLAY"
cp "out/build/$NAME/physx/diagnostics/stress-problem/libPhysXDestructionGpuRuntime_64.dylib" "$OVERLAY/lib/libPhysXDestructionGpuRuntime_64.dylib"
# Rewrites rpaths, records the overlay's own manifest and builds the Metal
# pipelines of the diagnostic kernels (different kernels, different archive).
python3 -B tools/scripts/relocate-macos-sdk.py "$OVERLAY" \
  "$CUMETAL/out/build/macos-cumetal/release/libcumetal.dylib" "$CUMETAL/runtime/api" "$OVERLAY/sdk-artifacts.json" \
  --warm "$CUMETAL/out/build/macos-cumetal/release/cumetal-warm" --gate-dir "$PHYSX/out/build/$NAME/pipeline-gate-stress-problem"
echo "installed $OVERLAY (diagnostic stress-problem capture runtime)"
