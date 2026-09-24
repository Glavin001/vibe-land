#!/bin/bash
# Server-less replay of a tape in headless Chromium, timing every frame.
# Uses the GPU, so run it under the GPU lock and with no game server running:
#
#   scripts/perf/gpu-run.sh tape-replay-perf \
#     scripts/perf/tape-analysis/run-replay-perf.sh <tape> <manifest.bin> [label] [width height dpr headless]
#
# Needs a built client in target/tape-analysis/replay-dist (see README.md).
# Writes target/tape-analysis/replay_perf_<label>.json; compare it with the
# live frames using replay_compare.py.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
TAPE=${1:?usage: run-replay-perf.sh <tape> <manifest.bin> [label] [width height dpr headless]}
MANIFEST=${2:?manifest .bin (the city manifest named by the tape header manifestHash)}
LABEL=${3:-headless}
OUT=${TAPE_ANALYSIS_OUT:-$ROOT/target/tape-analysis}
DIST=${REPLAY_DIST:-$OUT/replay-dist}
mkdir -p "$OUT"
echo "start $(date +%H:%M:%S)"
# Record what else was running: a live server on the same GPU invalidates the comparison.
pgrep -fl "web-fps-server" || echo "no web-fps-server running"
node "$HERE/replay-perf.mjs" "$DIST" "$TAPE" "$MANIFEST" "$OUT/replay_perf_${LABEL}.json" \
  "${4:-1512}" "${5:-945}" "${6:-2}" "${7:-1}"
echo "end $(date +%H:%M:%S)"
