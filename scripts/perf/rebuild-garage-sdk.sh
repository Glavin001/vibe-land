#!/bin/bash
# Rebuild and install the vehicle/garage PhysX SDK (../PhysX/out/install/garage-multihull)
# after changing PhysX or Blast sources, then refresh the artifact manifest the
# bridge verifies every library against.
#
#   scripts/perf/rebuild-garage-sdk.sh            # ~3-4 min with GPU source changes
#   PHYSX_SRC=../PhysX/.claude/worktrees/x GARAGE_SDK_NAME=garage-x scripts/perf/rebuild-garage-sdk.sh
#                                                 # a branch in its own worktree, built in its own
#                                                 # tree and installed beside the default SDK
#
# Steps (each needed): the gpu stage relinks libPhysXDestructionGpuRuntime;
# the sdk stage packages and installs (the Metal pipeline warm gate runs here);
# relocate writes ../PhysX/out/sdk-artifacts.json, which the install must carry.
# Flags must match the engine's CMake cache or the sdk stage refuses.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PHYSX=$(cd "$ROOT/../PhysX" && pwd)
# PHYSX_SRC: the checkout to build (default the main one). The build script
# keeps every build and install under that checkout's out/; a worktree's
# install is linked into the main checkout's out/install/$NAME, where
# PHYSX_ROOT points.
SRC=$(cd "${PHYSX_SRC:-$PHYSX}" && pwd)
NAME=${GARAGE_SDK_NAME:-garage-multihull}
OPTS=(--preset macos-cumetal --generator 'Unix Makefiles' --jobs 8
  --build-root "$SRC/out/build/$NAME" --install-prefix "$SRC/out/install/$NAME"
  --cumetal-rigid-demo --cumetal-explicit-aggregate-root --cumetal-explicit-motion-root
  --cumetal-explicit-hierarchy-root --cumetal-pack-bond-stress-scalars --cumetal-block-voted-traps
  --cumetal-particle-inline-threshold 500 --cumetal-softbody-inline-threshold 500)
cd "$SRC"
[ "${GARAGE_SDK_STAGE:-all}" = sdk ] || python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage gpu
[ "${GARAGE_SDK_STAGE:-all}" = gpu ] && exit 0
python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage sdk --install
cp out/sdk-artifacts.json "$SRC/out/install/$NAME/sdk-artifacts.json"
[ "$SRC" = "$PHYSX" ] || ln -sfn "$SRC/out/install/$NAME" "$PHYSX/out/install/$NAME"
echo "installed $PHYSX/out/install/$NAME from $SRC ($(grep -o 'PX_DESTRUCTION_SCENE_VERSION [0-9]*' "$PHYSX/out/install/$NAME/include/physx/PxDestructionScene.h"))"
