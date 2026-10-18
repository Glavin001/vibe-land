#!/bin/bash
# One locked recording session on this worktree's own server and ports:
#   scripts/perf/gpu-run.sh tape-replay client/e2e/tape-replay/run-record.sh <outDir> [seconds]
# Server: HTTP 127.0.0.1:4101, WebTransport :4102 (advertised as 127.0.0.1),
# binary and cwd from this worktree; needs the worktree's vite on :3103.
set -u
WT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?outDir}; SECONDS_=${2:-95}
BIN=${BIN:-/Users/glavin/Development/vibe-land/target/tape-replay/cargo/release/web-fps-server}
mkdir -p "$OUT"
cd "$WT"
BIND_ADDR=127.0.0.1:4101 WT_BIND_ADDR=0.0.0.0:4102 WT_HOST=127.0.0.1 SKIP_SPACETIMEDB_VERIFY=1 \
  VIBE_PHYSICS_BACKEND=physx_gpu CUMETAL_CACHE_DIR=/Users/glavin/Development/vibe-land/target/cumetal-cache \
  nohup "$BIN" > "$OUT/server.log" 2>&1 &
SERVER=$!
echo "server pid $SERVER"
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null' EXIT
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:4101/healthz >/dev/null && break; sleep 2; done
curl -s -m 2 http://127.0.0.1:4101/healthz >/dev/null || { echo "server did not come up"; tail -20 "$OUT/server.log"; exit 1; }
echo "server up after ~$((i * 2)) s"
cd "$WT/client"
SERVER_CWD="$WT" node e2e/tape-replay/record.mjs "$OUT" "$SECONDS_" 2>&1 | tee "$OUT/record.log"
