#!/bin/bash
# The impact solve's lab trials in the full high-fidelity profile
# (scripts/fidelity/high.env, the high packs) on the garage-impact SDK, with the
# acceptance probe (pass-through by path work, energy closure, joints held
# past capacity) and the impact log:
#   scripts/impact/high-trials.sh LABEL [TRIALS] [PACK_DIR]
# PACK_DIR: a high build of structures/vehicle-lab/out (scripts/fidelity/build-packs.sh high).
# Writes target/vehicle-testbed/LABEL{.out,.log,.json,-verdict.json}.
label=${1:?usage: high-trials.sh LABEL [TRIALS] [PACK_DIR]}
trials=${2:-cannonball-framed-house,meteor-framed-house,framed-house}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
H=${3:-$ROOT/target/fidelity/high/structures/vehicle-lab/out}
source "$ROOT/scripts/fidelity/high.env"
export PHYSX_ROOT=${IMPACT_PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-impact}
# HIGH_TRIALS_ENV: extra VAR=value words (e.g. "VIBE_IMPACT_CAPACITY=0 VIBE_IMPACT_STEP=1": the impact step's arm).
"$ROOT/scripts/impact/trials.sh" "$label" "$trials" VIBE_TESTBED_PROBE=1 \
  VIBE_CITY_SCENE="$H/vehicle-lab-crush.json" VIBE_TESTBED_META="$H/vehicle-lab-crush.meta.json" PX_DESTRUCTION_IMPACT_LOG=1 ${HIGH_TRIALS_ENV:-}
