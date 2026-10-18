#!/bin/bash
# Build the scene packs for an engine profile.
#   scripts/fidelity/build-packs.sh runtime   the default packs, in place (what ships)
#   scripts/fidelity/build-packs.sh high      every pack-build capability on, built in an
#                                             isolated copy under target/fidelity/high so the
#                                             default and crush packs other work uses are
#                                             never overwritten (TOWN_KIT_HULL_ORIGIN changes
#                                             pack contents without changing file names);
#                                             FIDELITY_PACK_DIR builds them elsewhere (a what-if)
# Prints the packs it built; scripts/fidelity/packs.sh PROFILE prints their paths.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
profile=${1:?usage: build-packs.sh runtime|high}
case $profile in
  runtime)
    source "$ROOT/scripts/fidelity/runtime.env"
    base=$ROOT ;;
  high)
    source "$ROOT/scripts/fidelity/high.env"
    base=${FIDELITY_PACK_DIR:-$ROOT/target/fidelity/high}
    mkdir -p "$base/client/native" "$base/client/src"
    rsync -a --delete --exclude out --exclude node_modules --exclude .vite --exclude __pycache__ "$ROOT/structures/" "$base/structures/"
    rsync -a --delete "$ROOT/client/native/film/" "$base/client/native/film/"
    rsync -a --delete "$ROOT/client/src/vehicles/" "$base/client/src/vehicles/"
    ln -sfn "$ROOT/client/node_modules" "$base/client/node_modules"
    # Read-only inputs: the authored scene packs the builders start from.
    mkdir -p "$base/destruction" && ln -sfn "$ROOT/destruction/assets" "$base/destruction/assets"
    # The copy resolves the Blast authoring tree from the real checkout's place.
    export TOWN_KIT_AUTHORING_ROOT=$(cd "$ROOT" && node -e "import('./structures/town-kit/src/dependencies.mjs').then(m => console.log(m.AUTHORING))")
    ;;
  *) echo "usage: $0 runtime|high" >&2; exit 2 ;;
esac
cd "$base"
echo "[packs] $profile: VIBE_CRUSH=${VIBE_CRUSH:-} VIBE_REAL_CAPACITIES=${VIBE_REAL_CAPACITIES:-} TOWN_KIT_HULL_ORIGIN=${TOWN_KIT_HULL_ORIGIN:-corner} in $base"
node structures/vehicle-lab/build-lab.mjs
node structures/town-kit/scripts/build-veneer-houses.mjs --storeys 1,2
node structures/vibe-town/build-town.mjs
"$ROOT/scripts/fidelity/packs.sh" "$profile"
