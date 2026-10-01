#!/bin/bash
# Rebuild and install the vehicle/garage PhysX SDK (../PhysX/out/install/garage-multihull)
# after changing PhysX or Blast sources, then refresh the artifact manifest the
# bridge verifies every library against.
#
#   scripts/perf/rebuild-garage-sdk.sh            # ~3-4 min with GPU source changes
#
# Steps (each needed): the gpu stage relinks libPhysXDestructionGpuRuntime;
# the sdk stage packages and installs (the Metal pipeline warm gate runs here);
# relocate writes ../PhysX/out/sdk-artifacts.json, which the install must carry.
# Flags must match the engine's CMake cache or the sdk stage refuses.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PHYSX=$(cd "$ROOT/../PhysX" && pwd)
NAME=${GARAGE_SDK_NAME:-garage-multihull}
OPTS=(--preset macos-cumetal --generator 'Unix Makefiles' --jobs 8
  --build-root "$PHYSX/out/build/$NAME" --install-prefix "$PHYSX/out/install/$NAME"
  --cumetal-rigid-demo --cumetal-explicit-aggregate-root --cumetal-explicit-motion-root
  --cumetal-explicit-hierarchy-root --cumetal-pack-bond-stress-scalars --cumetal-block-voted-traps
  --cumetal-particle-inline-threshold 500 --cumetal-softbody-inline-threshold 500)
cd "$PHYSX"
python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage gpu
python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage sdk --install
cp out/sdk-artifacts.json "out/install/$NAME/sdk-artifacts.json"
echo "installed $PHYSX/out/install/$NAME ($(grep -o 'PX_DESTRUCTION_SCENE_VERSION [0-9]*' "out/install/$NAME/include/physx/PxDestructionScene.h"))"
