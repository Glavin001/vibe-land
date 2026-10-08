#!/bin/bash
# Which capabilities of the current profile does $PHYSX_ROOT carry?
#   scripts/fidelity/check.sh            report; exit 1 if any enabled flag is unsupported
#   source scripts/fidelity/check.sh --degrade
#                                        unset the unsupported flags (and say so), so a run
#                                        can go ahead on the best SDK available and report
#                                        exactly what it did not exercise
header="$PHYSX_ROOT/include/physx/PxDestructionScene.h"
[ -f "$header" ] || header="$PHYSX_ROOT/include/PxDestructionScene.h"
has() { grep -q "#define $1 1" "$header" 2>/dev/null; }
missing=()
need() { # flag macro
  local flag=$1 macro=$2 value=${!1:-}
  if [ -n "$value" ] && [ "$value" != 0 ] && ! has "$macro"; then missing+=("$flag ($macro)"); fi
}
need VIBE_SECTION_BENDING PX_DESTRUCTION_SECTION_BENDING
need VIBE_SECTION_ROTATION PX_DESTRUCTION_SECTION_ROTATIONAL_STIFFNESS
need VIBE_IMPACT_CAPACITY PX_DESTRUCTION_IMPACT_CAPACITY
need VIBE_IMPACT_STEP PX_DESTRUCTION_IMPACT_STEP
need VIBE_NATIVE_CRUSH PX_DESTRUCTION_CRUSH_CORRECTION
echo "[fidelity] profile ${VIBE_FIDELITY_PROFILE:-${VIBE_FIDELITY:-runtime}} on SDK ${PHYSX_ROOT:-unset}"
if [ ${#missing[@]} -eq 0 ]; then
  echo "[fidelity] every enabled capability is in this SDK"
  return 0 2>/dev/null || exit 0
fi
for m in "${missing[@]}"; do echo "[fidelity] NOT IN THIS SDK: $m"; done
if [ "${1:-}" = --degrade ]; then
  for m in "${missing[@]}"; do unset "${m%% *}"; done
  export VIBE_FIDELITY_MISSING="${missing[*]}"
  echo "[fidelity] running without them (VIBE_FIDELITY_MISSING records it)"
  return 0 2>/dev/null || exit 0
fi
return 1 2>/dev/null || exit 1
