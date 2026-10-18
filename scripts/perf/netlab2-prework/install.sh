#!/usr/bin/env bash
# Make a pre-work client tree (before 0eb6f3fd, e.g. e3fdf5cc) scoreable by
# Netlab v2's all-draws headline, without changing what it draws.
#
#   scripts/perf/netlab2-prework/install.sh <worktree of e3fdf5cc>
#
# The lab's client stage imports the renderers' pose steps from
# `--client-root`. They were extracted from the renderers in 3f3d891a, so an
# older tree has none of them and the stage would score no city chunks and
# no meteors. This installs, into the given worktree only:
#
#   client/src/city/cityPoseStore.ts   3f3d891a's file. CityChunksLayer.tsx,
#                                      citySlotMesh.ts and cityChunkMesh.ts are
#                                      unchanged in their pose logic from
#                                      e3fdf5cc to 3f3d891a~1, so this is the
#                                      e3fdf5cc layer's own step.
#   client/src/scene/netEntityPoses.ts 3f3d891a's file; netEntityRenderers.ts is
#                                      unchanged from e3fdf5cc to 3f3d891a~1.
#   client/src/vfx/meteorPlacement.ts  meteorPlacement.ts beside this script:
#                                      e3fdf5cc MeteorLayer's placement rule.
#
# docs/netcode-tuning.md "Netcode scoreboard (2026-09-24)" says what "before"
# means for every row.
set -euo pipefail
tree=${1:?usage: install.sh <pre-work worktree>}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
head=$(git -C "$tree" rev-parse HEAD)
if git -C "$repo" merge-base --is-ancestor 0eb6f3fd "$head"; then
  echo "$tree is at or after 0eb6f3fd: it has its own meteorPlacement.ts; nothing to install" >&2
  exit 1
fi
git -C "$repo" show 3f3d891a:client/src/city/cityPoseStore.ts > "$tree/client/src/city/cityPoseStore.ts"
git -C "$repo" show 3f3d891a:client/src/scene/netEntityPoses.ts > "$tree/client/src/scene/netEntityPoses.ts"
cp "$here/meteorPlacement.ts" "$tree/client/src/vfx/meteorPlacement.ts"
echo "installed the pose-step adapters into $tree (pre-work client $head)"
