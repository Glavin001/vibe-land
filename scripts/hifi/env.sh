# The integration/high-fidelity runs: the combined SDK for both profiles, the
# shared GPU, this checkout's own build trees, logs in target/hifi-logs.
#   source scripts/hifi/env.sh PROFILE     (runtime | high)
HIFI_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export HIFI_SDK=${HIFI_SDK:-/Users/glavin/Development/PhysX/out/install/garage-hifi}
export HIFI_PHYSX_TESTS=${HIFI_PHYSX_TESTS:-/Users/glavin/Development/PhysX/.claude/worktrees/hifi/out/build/garage-hifi/package}
export HIGH_PHYSX_ROOT=$HIFI_SDK RUNTIME_PHYSX_ROOT=$HIFI_SDK
source "$HIFI_ROOT/scripts/fidelity/${1:?usage: source env.sh runtime|high}.env"
eval "$("$HIFI_ROOT/scripts/fidelity/packs.sh" "$1")"
export VIBE_GPU_SHARED=1
export MYSTRAL_ROOT=${MYSTRAL_ROOT:-/Users/glavin/Development/mystralnative}
export VIBE_SIM_TARGET=$HIFI_ROOT/target/hifi-sim CARGO_TARGET_DIR=$HIFI_ROOT/target/hifi
export TOWN_KIT_AUTHORING_ROOT=${TOWN_KIT_AUTHORING_ROOT:-/Users/glavin/Development/PhysX/.claude/worktrees/hifi/blast/blast-stress-solver/structures}
export HIFI_LOGS=$HIFI_ROOT/target/hifi-logs; mkdir -p "$HIFI_LOGS"
