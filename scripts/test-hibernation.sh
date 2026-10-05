#!/bin/bash
# Debris hibernation tests (physx-bridge/tests/native_hibernation.rs) against a
# PhysX SDK with PxDestructionScene v25, with the server's stage settings.
#   scripts/test-hibernation.sh [test-name-filter] [-- --ignored]
# PHYSX_ROOT: the v25 install (default: the PhysX hibernation worktree's).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
export PHYSX_ROOT=${PHYSX_ROOT:-$ROOT/../PhysX/.claude/worktrees/hibernate/out/install/hibernate}
[ -d "$PHYSX_ROOT" ] || PHYSX_ROOT=$(cd "$ROOT/../../.." 2>/dev/null && pwd)/../PhysX/.claude/worktrees/hibernate/out/install/hibernate
grep -q "PX_DESTRUCTION_SCENE_VERSION 25" "$PHYSX_ROOT/include/physx/PxDestructionScene.h" \
  || { echo "PHYSX_ROOT=$PHYSX_ROOT is not a v25 SDK" >&2; exit 1; }
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$ROOT/target/hibernate}
export PX_DESTRUCTION_ALLOW_UNCONVERGED=1 BLAST_STRESS_INCREMENTAL_MOTION=1 \
  PX_DESTRUCTION_INCREMENTAL_TOPOLOGY=1 BLAST_STRESS_BALANCED_OPERATOR=1
export CUMETAL_CACHE_DIR=${CUMETAL_CACHE_DIR:-$ROOT/target/cumetal-cache-hibernate}
exec cargo test --release -p vibe-land-physx-bridge --features native-destruction \
  --test native_hibernation -- --nocapture --test-threads=1 "$@"
