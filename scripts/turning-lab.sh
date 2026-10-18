#!/usr/bin/env bash
# The monster truck driven by a closed-loop driver on the player's controls
# alone, in the vehicle lab's scene (client/native/films/turning.mjs):
#
#   scripts/turning-lab.sh MODE [native-mac.sh film args]
#
# MODE picks the episodes (structures/vehicle-lab/turning.mjs episodesFor):
# one car per episode, parked at its slot. FILM_CHECK=1 for stills and no
# video; FILM_FPS / FILM_SIZE / FILM_SEED as for any film. TURNING_DEFINES
# adds esbuild defines. Does not take the GPU lock: the caller does.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:?usage: $0 MODE [args]}"; shift
slots=$(node --input-type=module -e "import { slotsFor } from '$ROOT/structures/vehicle-lab/turning.mjs'; process.stdout.write(slotsFor('$mode'))")
n=$(awk -F';' '{print NF}' <<<"$slots")
build="${TURNING_BUILD:-monster}"
export VIBE_CITY_DESTRUCTIBLE_VEHICLES=$(node -e 'process.stdout.write(Array(+process.argv[2]).fill(process.argv[1]).join(","))' "$build" "$n") \
  VIBE_CITY_FLEET_SLOTS="$slots" \
  FILM_DEFINES="--define:TURNING_MODE=\"$mode\" ${TURNING_DEFINES:-}"
exec "$ROOT/scripts/native-mac.sh" film turning --scene lab "$@"
