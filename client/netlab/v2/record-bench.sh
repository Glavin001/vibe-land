#!/bin/bash
# Record a heavier paired capture for Netlab v2 with the city benchmark's
# scripted multi-client driver (client/e2e/city-bench), on THIS worktree's
# server, client and ports:
#
#   client/netlab/v2/record-bench.sh <outDir> [scenario=quick] [clients=3]
#
# Same shape as scripts/perf/city-bench.sh's locked part (its locked.sh,
# unchanged, with this worktree's ports and binary): <outDir>/debug-reports/
# session-<run>-c<n> are the bundles, <outDir>/client-<n>-drawn.jsonl the live
# renderers' samples that `netlab2 calibrate` compares against. Build first
# (docs/netlab-v2.md).
set -u
WT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?outDir}; NAME=${2:-quick}; export CLIENTS=${3:-3}
export HTTP_PORT=${HTTP_PORT:-4501} WT_PORT=${WT_PORT:-4502} CLIENT_PORT=${CLIENT_PORT:-3503}
export BIN=${BIN:-/Users/glavin/Development/vibe-land/target/netlab-v2/cargo/release/web-fps-server}
export SCENARIO="$WT/client/e2e/city-bench/scenarios/$NAME.json"
export RUN_ID="netlab2-$(date +%Y%m%d-%H%M%S)-$NAME-${CLIENTS}c"
GPU_RUN=${GPU_RUN:-/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh}
[ -x "$BIN" ] || { echo "no server binary at $BIN" >&2; exit 10; }
[ -f "$SCENARIO" ] || { echo "no scenario $SCENARIO" >&2; exit 10; }
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
if curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null; then
  echo "something already answers on :$CLIENT_PORT" >&2; exit 11
fi
(cd "$WT/client" && CLIENT_PORT=$CLIENT_PORT SERVER_PORT=$HTTP_PORT SERVER_HOST=127.0.0.1 \
  VITE_CACHE_DIR=/Users/glavin/Development/vibe-land/target/netlab-v2/vite-cache \
  exec npx vite --config e2e/city-bench/vite.bench.config.ts --port "$CLIENT_PORT" --strictPort) \
  > "$OUT/vite.log" 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null; pkill -P $VITE 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null && break; sleep 1; done
curl -s -m 120 "http://localhost:$CLIENT_PORT/city" >/dev/null || { echo "vite did not start; see $OUT/vite.log" >&2; exit 11; }
echo "waiting for the GPU lock (owner: $(cat /Users/glavin/Development/vibe-land/target/perf-tools/gpu.lock/owner 2>/dev/null || echo none))"
"$GPU_RUN" netlab2-bench "$WT/scripts/perf/city-bench/locked.sh" "$OUT"
