#!/usr/bin/env bash
# Bundle the Phase 0 spike for mystralnative: one ESM file + the shared WASM.
#   build.sh [out-name] [path to an alternative three.webgpu.js]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
client="$(cd "$here/../.." && pwd)"
out="${1:-spike}"
alias_args=()
if [[ -n "${2:-}" ]]; then alias_args=(--alias:three/webgpu="$2"); fi
mkdir -p "$here/dist/assets"
"$client/node_modules/.bin/esbuild" "$here/spike.ts" \
  --bundle --format=esm --platform=browser --target=es2022 \
  --define:SPIKE_FLAGS="\"${SPIKE_FLAGS:-}\"" --define:import.meta.url='"file://./"' --log-level=warning \
  ${alias_args[@]+"${alias_args[@]}"} \
  --outfile="$here/dist/$out.js"
cp "$client/src/wasm/pkg/vibe_land_shared_bg.wasm" "$here/dist/assets/"
echo "built $here/dist/$out.js"
