#!/usr/bin/env bash
# Bundle the in-process sim probe. Usage: build-probe.sh <libvibe_sim.dylib>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
client="$(cd "$here/../.." && pwd)"
lib="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
mkdir -p "$here/dist"
"$client/node_modules/.bin/esbuild" "$here/probe.ts" \
  --bundle --format=esm --platform=browser --target=es2022 --log-level=warning \
  --define:VIBE_SIM_PATH="\"$lib\"" \
  --outfile="$here/dist/probe.js"
echo "built $here/dist/probe.js (sim: $lib)"
