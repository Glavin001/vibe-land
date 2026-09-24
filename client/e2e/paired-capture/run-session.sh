#!/bin/bash
# One locked, paired recording session on this worktree's own server and
# ports, then the bundle inspector over what it recorded:
#   scripts/perf/gpu-run.sh paired-capture client/e2e/paired-capture/run-session.sh <outDir> [seconds]
# Server: HTTP 127.0.0.1:$HTTP_PORT (4201), WebTransport :$WT_PORT (4202)
# advertised as 127.0.0.1; needs this worktree's vite on :$CLIENT_PORT (3203)
# proxying to the server. Reports and bundles go to <outDir>/debug-reports.
set -u
WT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?outDir}; SECONDS_=${2:-95}
HTTP_PORT=${HTTP_PORT:-4201}; WT_PORT=${WT_PORT:-4202}; CLIENT_PORT=${CLIENT_PORT:-3203}
BIN=${BIN:-/Users/glavin/Development/vibe-land/target/paired-capture/cargo/release/web-fps-server}
mkdir -p "$OUT/debug-reports"
OUT=$(cd "$OUT" && pwd)
cd "$WT"
BIND_ADDR=127.0.0.1:$HTTP_PORT WT_BIND_ADDR=0.0.0.0:$WT_PORT WT_HOST=127.0.0.1 WEB_BIND_ADDR= \
  SKIP_SPACETIMEDB_VERIFY=1 VIBE_DEBUG_REPORTS_DIR="$OUT/debug-reports" RUST_LOG=info \
  VIBE_PHYSICS_BACKEND=${BACKEND:-physx_gpu} CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache \
  nohup "$BIN" > "$OUT/server.log" 2>&1 &
SERVER=$!
echo "server pid $SERVER"
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null' EXIT
for i in $(seq 1 120); do curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null && break; sleep 2; done
curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null || { echo "server did not come up"; tail -20 "$OUT/server.log"; exit 1; }
echo "server up after ~$((i * 2)) s"
cd "$WT/client"
PAIRED=1 CLIENT="http://localhost:$CLIENT_PORT" API="http://127.0.0.1:$HTTP_PORT" \
  SERVER_CWD="$WT" REPORTS_DIR="$OUT/debug-reports" \
  node e2e/tape-replay/record.mjs "$OUT" "$SECONDS_" 2>&1 | tee "$OUT/record.log"
if [ -d "$OUT/bundle" ]; then
  python3 "$WT/scripts/perf/session_bundle.py" "$OUT/bundle" --json "$OUT/inspect.json" | tee "$OUT/inspect.txt"
fi
