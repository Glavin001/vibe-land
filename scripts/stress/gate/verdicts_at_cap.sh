#!/bin/bash
# Verdicts at the iteration cap vs the CPU oracle, both flags (section
# rotation, and real capacities where the pack was built with them).
# The GPU runs unbreakable copies (limits x1e6) with the app's solver
# settings; the oracle grades the same stresses at the pack's real limits.
#   OUT=dir CAPS="16 64" scripts/stress/gate/verdicts_at_cap.sh PACK[:part,part] ...
set -u
cd "$(dirname "$0")/../../.."
G=scripts/stress/gate
OUT=${OUT:-target/stress-gate}
for cap in ${CAPS:-16 64}; do
  echo "######## cap $cap"
  VIBE_GPU_SHARED=1 PX_DESTRUCTION_ALLOW_UNCONVERGED=1 GATE_UNBREAKABLE=1 GATE_SOLVER_ENV=app \
  GATE_SNAPSHOTS=${SNAPS:-0,1} GATE_TICKS=${TICKS:-120} \
  QUALIFY_TARGET_DIR=${QUALIFY_TARGET_DIR:-$PWD/target/section-rotation-qualify} \
  PHYSX_ROOT=${PHYSX_ROOT:-/Users/glavin/Development/PhysX/out/install/garage-multihull} \
  VIBE_SECTION_ROTATION=1 VIBE_CITY_NATIVE_STRESS_ITERATIONS=$cap \
  python3 $G/oracle_gate.py "$OUT/cap-$cap" "$@" 2>&1 | grep -v "^Installed\|^warning"
done
