#!/bin/bash
# Record a live, paired loopback session with THIS worktree's server and
# client, as Netlab v2's frozen truth and calibration reference:
#
#   client/netlab/v2/record-bundle.sh <outDir> [seconds]
#
# Builds nothing: run `cargo build --release -p web-fps-server --features
# native-destruction --bin web-fps-server` (CARGO_TARGET_DIR below) and the
# client WASM first (docs/netlab-v2.md). Starts this worktree's vite on
# :$CLIENT_PORT with a private dependency cache, then takes the machine-wide
# GPU lock only for the server + browser (client/e2e/paired-capture/
# run-session.sh on this worktree's own ports), which records the scripted
# session of client/e2e/tape-replay/record.mjs. Output: <outDir>/bundle (the
# paired session bundle) and <outDir>/live-samples.json (the live renderers'
# positions), which `netlab2 calibrate` picks up.
set -u
WT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?outDir}; SECONDS_=${2:-75}
export HTTP_PORT=${HTTP_PORT:-4501} WT_PORT=${WT_PORT:-4502} CLIENT_PORT=${CLIENT_PORT:-3503}
export BIN=${BIN:-/Users/glavin/Development/vibe-land/target/netlab-v2/cargo/release/web-fps-server}
GPU_RUN=${GPU_RUN:-/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh}
[ -x "$BIN" ] || { echo "no server binary at $BIN" >&2; exit 10; }
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
"$GPU_RUN" netlab2-record "$WT/client/e2e/paired-capture/run-session.sh" "$OUT" "$SECONDS_"
