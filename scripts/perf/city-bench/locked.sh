#!/bin/bash
# The GPU part of one city-bench run: its own server, then the driver.
# Called by scripts/perf/city-bench.sh under scripts/perf/gpu-run.sh; not
# meant to be run by hand. Always stops the server and the driver's browsers.
#   locked.sh <runDir>        (environment: see city-bench.sh)
set -u
RUN_DIR=${1:?runDir}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
HTTP_PORT=${HTTP_PORT:-4301}; WT_PORT=${WT_PORT:-4302}; CLIENT_PORT=${CLIENT_PORT:-3303}
BIN=${BIN:?BIN}
SERVER=""; DRIVER=""; KILLER=""
# The driver and everything it started (Playwright's browsers and their GPU
# processes), children first.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
}
cleanup() {
  local code=$?
  [ -n "$KILLER" ] && kill_tree "$KILLER"
  [ -n "$DRIVER" ] && kill_tree "$DRIVER"
  if [ -n "$SERVER" ]; then
    kill "$SERVER" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER" 2>/dev/null
    wait "$SERVER" 2>/dev/null
  fi
  echo "locked part finished (exit $code) at $(date +%H:%M:%S); GPU lock released by the caller"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null; then
  echo "FAIL: something already answers on 127.0.0.1:$HTTP_PORT; refusing to share a server" >&2
  exit 3
fi
mkdir -p "$RUN_DIR/debug-reports"
echo "server $BIN on 127.0.0.1:$HTTP_PORT (WT :$WT_PORT) at $(date +%H:%M:%S)"
env BIND_ADDR=127.0.0.1:$HTTP_PORT WT_BIND_ADDR=0.0.0.0:$WT_PORT WT_HOST=127.0.0.1 WEB_BIND_ADDR= \
  SKIP_SPACETIMEDB_VERIFY=1 VIBE_DEBUG_REPORTS_DIR="$RUN_DIR/debug-reports" RUST_LOG=${RUST_LOG:-info} \
  VIBE_PHYSICS_BACKEND=${VIBE_PHYSICS_BACKEND:-physx_gpu} \
  CUMETAL_CACHE_DIR=${CUMETAL_CACHE_DIR:-/Users/glavin/Development/vibe-land/target/cumetal-cache} \
  "$BIN" > "$RUN_DIR/server.log" 2>&1 &
SERVER=$!
up=0
for i in $(seq 1 150); do
  kill -0 "$SERVER" 2>/dev/null || { echo "FAIL: server exited during startup" >&2; tail -30 "$RUN_DIR/server.log" >&2; exit 4; }
  curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null && { up=1; break; }
  sleep 2
done
[ "$up" = 1 ] || { echo "FAIL: server did not answer /healthz within 300 s" >&2; tail -30 "$RUN_DIR/server.log" >&2; exit 4; }
echo "server up after ~$((i * 2)) s"

cd "$ROOT/client"
OUT="$RUN_DIR" CLIENT="http://localhost:$CLIENT_PORT" API="http://127.0.0.1:$HTTP_PORT" \
  node e2e/city-bench/bench.mjs > >(tee "$RUN_DIR/driver.log") 2>&1 &
DRIVER=$!
# Hard stop well past the driver's own watchdog.
HARD_S=${HARD_TIMEOUT_S:-1800}
( sleep "$HARD_S"; echo "FAIL: hard timeout ${HARD_S} s; killing the driver" >&2; kill "$DRIVER" 2>/dev/null ) &
KILLER=$!
wait "$DRIVER"; code=$?
DRIVER=""
kill_tree "$KILLER"; KILLER=""
if ! kill -0 "$SERVER" 2>/dev/null; then
  echo "FAIL: the server died during the run" >&2; tail -30 "$RUN_DIR/server.log" >&2
  [ "$code" = 0 ] && code=5
fi
exit "$code"
