#!/bin/bash
# One rest-sleep soak session: one server that stays up for the whole run,
# driven by soak.mjs. Takes the machine-wide GPU lock only for the server and
# the browser; the client dev server starts before it.
#   scripts/perf/rest-soak/run.sh <on|off> [duration_s]
# Environment: HTTP_PORT (6401), WT_PORT (6402), CLIENT_PORT (3643),
# BIN (target/rest-soak/cargo/release/web-fps-server), OUT_ROOT
# (target/rest-soak), CLIENT_DIR (the main checkout's client), DRIVER_JS
# (soak.mjs; reset-soak.mjs resets with the player standing on rubble).
set -u
MODE=${1:?on|off}; DURATION_S=${2:-1860}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAIN=/Users/glavin/Development/vibe-land
OUT_ROOT=${OUT_ROOT:-$MAIN/target/rest-soak}
BIN=${BIN:-$OUT_ROOT/cargo/release/web-fps-server}
CLIENT_DIR=${CLIENT_DIR:-$MAIN/client}
DRIVER_JS=${DRIVER_JS:-$HERE/soak.mjs}
HTTP_PORT=${HTTP_PORT:-6401}; WT_PORT=${WT_PORT:-6402}; CLIENT_PORT=${CLIENT_PORT:-3643}
RUN_DIR="$OUT_ROOT/runs/$(date +%Y%m%d-%H%M%S)-rest-$MODE"
mkdir -p "$RUN_DIR/debug-reports"
exec > >(tee -a "$RUN_DIR/run.log") 2>&1
echo "rest-soak $MODE for ${DURATION_S}s -> $RUN_DIR"

for p in $HTTP_PORT $WT_PORT $CLIENT_PORT; do
  if lsof -nP -iTCP:$p -iUDP:$p >/dev/null 2>&1; then echo "FAIL: port $p is in use" >&2; exit 11; fi
done

VITE=""; SERVER=""; DRIVER=""
kill_tree() { local pid=$1 c; for c in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$c"; done; kill "$pid" 2>/dev/null; }
cleanup() {
  [ -n "$DRIVER" ] && kill_tree "$DRIVER"
  if [ -n "$SERVER" ]; then
    kill "$SERVER" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$SERVER" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$SERVER" 2>/dev/null
  fi
  [ -n "$VITE" ] && kill_tree "$VITE"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

(cd "$CLIENT_DIR" && CLIENT_PORT=$CLIENT_PORT SERVER_PORT=$HTTP_PORT SERVER_HOST=127.0.0.1 \
  VITE_CACHE_DIR="$OUT_ROOT/vite-cache" exec npx vite --config e2e/city-bench/vite.bench.config.ts \
  --port "$CLIENT_PORT" --strictPort) > "$RUN_DIR/vite.log" 2>&1 &
VITE=$!
for _ in $(seq 1 60); do curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null && break; sleep 1; done
curl -s -m 120 "http://localhost:$CLIENT_PORT/city" >/dev/null || { echo "FAIL: client dev server"; exit 11; }

locked() {
  echo "GPU lock taken at $(date +%H:%M:%S)"
  local rest=()
  [ "$MODE" = on ] && rest=(VIBE_CITY_NATIVE_REST_SLEEP=1)
  env ${rest[@]+"${rest[@]}"} BIND_ADDR=127.0.0.1:$HTTP_PORT WT_BIND_ADDR=0.0.0.0:$WT_PORT WT_HOST=127.0.0.1 WEB_BIND_ADDR= \
    SKIP_SPACETIMEDB_VERIFY=1 VIBE_DEBUG_REPORTS_DIR="$RUN_DIR/debug-reports" RUST_LOG=info \
    VIBE_PHYSICS_BACKEND=physx_gpu CUMETAL_CACHE_DIR=$MAIN/target/cumetal-cache \
    "$BIN" > "$RUN_DIR/server.log" 2>&1 &
  SERVER=$!
  echo "$SERVER" > "$RUN_DIR/server.pid"
  ps -o pid,nice,command -p $SERVER | tail -1
  local up=0 i
  for i in $(seq 1 150); do
    kill -0 "$SERVER" 2>/dev/null || { echo "FAIL: server exited during startup"; tail -30 "$RUN_DIR/server.log"; return 4; }
    curl -s -m 2 "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null && { up=1; break; }
    sleep 2
  done
  [ "$up" = 1 ] || { echo "FAIL: no /healthz"; return 4; }
  echo "server up after ~$((i * 2)) s: $(curl -s http://127.0.0.1:$HTTP_PORT/healthz | head -c 300)"
  (cd "$CLIENT_DIR" && OUT="$RUN_DIR" CLIENT="http://localhost:$CLIENT_PORT" API="http://127.0.0.1:$HTTP_PORT" \
    DURATION_S=$DURATION_S LABEL="$MODE" CLIENT_DIR="$CLIENT_DIR" exec node "$DRIVER_JS") > "$RUN_DIR/driver.log" 2>&1 &
  DRIVER=$!
  local hard=$((DURATION_S + 900)) t=0 code
  while kill -0 "$DRIVER" 2>/dev/null; do
    sleep 5; t=$((t + 5))
    if ! kill -0 "$SERVER" 2>/dev/null; then echo "FAIL: the server died at +${t}s"; tail -40 "$RUN_DIR/server.log"; kill_tree "$DRIVER"; break; fi
    [ $t -ge $hard ] && { echo "FAIL: hard timeout"; kill_tree "$DRIVER"; break; }
  done
  wait "$DRIVER"; code=$?; DRIVER=""
  kill -0 "$SERVER" 2>/dev/null && echo "server still alive at the end" || { echo "server NOT alive at the end"; code=5; }
  kill "$SERVER" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$SERVER" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$SERVER" 2>/dev/null; SERVER=""
  echo "locked part finished (driver exit $code) at $(date +%H:%M:%S)"
  return $code
}
export -f locked kill_tree
export MODE DURATION_S HERE MAIN RUN_DIR BIN CLIENT_DIR DRIVER_JS HTTP_PORT WT_PORT CLIENT_PORT
echo "waiting for the GPU lock (owner: $(cat $MAIN/target/perf-tools/gpu.lock/owner 2>/dev/null || echo none))"
$MAIN/scripts/perf/gpu-run.sh "rest-soak-$MODE" bash -c 'SERVER=""; DRIVER=""; trap "[ -n \"\$DRIVER\" ] && kill_tree \$DRIVER; [ -n \"\$SERVER\" ] && kill \$SERVER 2>/dev/null" EXIT; locked'
echo "exit $?"
