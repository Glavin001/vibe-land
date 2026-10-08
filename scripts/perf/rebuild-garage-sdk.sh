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
#
# Versioned installs: the sdk stage installs into out/install/$NAME@<rev> (the
# source revision, 9 hex), then repoints out/install/$NAME, a relative symlink,
# at it in one rename. Nothing a live run opened is rewritten. The run entry
# points (vehicle-testbed.sh, acceptance.sh) resolve the symlink when they start,
# so a run keeps one revision throughout: PHYSX_ROOT=$NAME@<rev>. A plain-directory
# install from before versioning is moved to $NAME@<its rev> first. The three
# newest versions are kept; an older one goes only when `lsof +D` finds no
# process with a file open in it.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PHYSX=$(cd "$ROOT/../PhysX" && pwd)
# PHYSX_SRC: the checkout to build (default the main one). The build script
# keeps every build and install under that checkout's out/; a worktree's
# install is linked into the main checkout's out/install/$NAME, where
# PHYSX_ROOT points.
SRC=$(cd "${PHYSX_SRC:-$PHYSX}" && pwd)
NAME=${GARAGE_SDK_NAME:-garage-multihull}
LINK="$SRC/out/install/$NAME"
REV=$(git -C "$SRC" rev-parse --short=9 HEAD)
VERSIONED="$LINK@$REV"
OPTS=(--preset macos-cumetal --generator 'Unix Makefiles' --jobs 8
  --build-root "$SRC/out/build/$NAME" --install-prefix "$VERSIONED"
  --cumetal-rigid-demo --cumetal-explicit-aggregate-root --cumetal-explicit-motion-root
  --cumetal-explicit-hierarchy-root --cumetal-pack-bond-stress-scalars --cumetal-block-voted-traps
  --cumetal-particle-inline-threshold 500 --cumetal-softbody-inline-threshold 500)
cd "$SRC"
[ "${GARAGE_SDK_STAGE:-all}" = sdk ] || python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage gpu
[ "${GARAGE_SDK_STAGE:-all}" = gpu ] && exit 0
# A plain-directory install from before versioning: move it aside under its
# own revision (its open files stay valid), so $LINK can become the symlink.
if [ -d "$LINK" ] && [ ! -L "$LINK" ]; then
  old=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("source_revision","")[:9] or "unknown")' "$LINK/sdk-artifacts.json" 2>/dev/null || echo unknown)
  dest="$LINK@$old"; [ -e "$dest" ] && dest="$dest-$(date +%s)"
  mv "$LINK" "$dest"; ln -s "$(basename "$dest")" "$LINK"
  echo "moved the unversioned install to $dest"
fi
python3 -B tools/scripts/build-destruction-sdk.py "${OPTS[@]}" --stage sdk --install
cp out/sdk-artifacts.json "$VERSIONED/sdk-artifacts.json"
# Repoint $LINK in one rename (a relative link, so the tree can move).
ln -sfn "$(basename "$VERSIONED")" "$LINK.next" && python3 -c 'import os,sys;os.replace(sys.argv[1],sys.argv[2])' "$LINK.next" "$LINK"
[ "$SRC" = "$PHYSX" ] || ln -sfn "$LINK" "$PHYSX/out/install/$NAME"
# Keep the three newest versions; an older one goes only when nothing has a file open in it.
ls -dt "$LINK"@* 2>/dev/null | tail -n +4 | while read -r v; do
  [ "$(readlink "$LINK")" = "$(basename "$v")" ] && continue
  if lsof +D "$v" >/dev/null 2>&1; then echo "kept $v (in use)"; else rm -rf "$v"; fi
done
echo "installed $VERSIONED, $PHYSX/out/install/$NAME -> it, from $SRC ($(grep -o 'PX_DESTRUCTION_SCENE_VERSION [0-9]*' "$PHYSX/out/install/$NAME/include/physx/PxDestructionScene.h"))"
