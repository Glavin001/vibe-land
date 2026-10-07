#!/bin/bash
# The correctness suite (scripts/verify/correctness.sh) on the combined SDK:
# every SDK slot (runtime, rotation, crush, high) and the ctest builds point at
# garage-hifi and its test tree.   scripts/hifi/matrix.sh [quick|full] [--only ...]
source "$(dirname "$0")/env.sh" runtime
export RUNTIME_PHYSX_ROOT=$HIFI_SDK VERIFY_ROTATION_PHYSX_ROOT=$HIFI_SDK VERIFY_CRUSH_PHYSX_ROOT=$HIFI_SDK \
  VERIFY_HIGH_PHYSX_ROOT=$HIFI_SDK VERIFY_PHYSX_BUILD=$HIFI_PHYSX_TESTS VERIFY_IMPACT_BUILD=$HIFI_PHYSX_TESTS
unset CARGO_TARGET_DIR PX_DESTRUCTION_ALLOW_UNCONVERGED
export VERIFY_OUT_DIR=$HIFI_ROOT/target/verify/hifi-$(date +%H%M%S)
"$HIFI_ROOT/scripts/verify/correctness.sh" "$@" > "$HIFI_LOGS/matrix-$(basename "$VERIFY_OUT_DIR").log" 2>&1
echo "matrix: exit $? ($VERIFY_OUT_DIR)"
