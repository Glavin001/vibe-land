#!/usr/bin/env bash
# The browser /city and the Unreal client on one server, in one match.
#
#   scripts/unreal/demo.sh [--match citypp-demo] [--synthetic] [--no-unreal]
#
# Starts what is not already running:
#   * the city server on :4001/:4002 -- the PhysX city server built against the garage SDK
#     (scripts/perf/garage-vehicle-server.sh, ../PhysX/out/install/garage-multihull, in a shared
#     GPU slot), or with --synthetic the physics-free city (no GPU; shots do nothing there);
#   * the web client (Vite, :3003);
# then prints the browser URL and launches the Unreal client (unreal/VibeCity) on the same match.
# Logs go to target/unreal-demo/. Stop with Ctrl-C; servers this script started are stopped too.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MATCH="citypp-demo"
SYNTHETIC=0
UNREAL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --match) MATCH="$2"; shift 2 ;;
    --synthetic) SYNTHETIC=1; shift ;;
    --no-unreal) UNREAL=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "demo: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$MATCH" in citypp*) ;; *) echo "demo: the Unreal client speaks city wire 4 only; use a citypp* match" >&2; exit 2 ;; esac

UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
LOGS="$ROOT/target/unreal-demo"
mkdir -p "$LOGS"
STARTED=()
OWN_PORTS=()
# Stop what this script started. Servers run under gpu-run.sh, which a kill of its shell leaves
# running (holding its GPU slot), so stop them by the port they listen on.
cleanup() {
  for port in "${OWN_PORTS[@]:-}"; do
    [[ -n "$port" ]] && kill $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null) 2>/dev/null || true
  done
  for pid in "${STARTED[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_for() { # wait_for <url> <seconds> <what>
  for _ in $(seq 1 "$2"); do curl -fs -o /dev/null "$1" && return 0; sleep 1; done
  echo "demo: $3 did not come up ($1); see $LOGS" >&2; exit 1
}

if listening 4001; then
  echo "demo: a server is already on :4001; using it"
elif [[ "$SYNTHETIC" == 1 ]]; then
  (cd "$ROOT" && cargo build -q --release -p web-fps-server --bin web-fps-server 2>&1 | grep -E '^error' || true)
  VIBE_CITY_SYNTHETIC=1 RUST_LOG=info "$ROOT/target/release/web-fps-server" > "$LOGS/server.log" 2>&1 &
  STARTED+=($!); OWN_PORTS+=(4001)
else
  # play-server.sh links ../PhysX/out/install/macos-cumetal, which predates this branch's bridge
  # (destruction scene v18); the garage SDK (v24) is the one the native app and this server use.
  VIBE_GPU_SHARED=1 "$ROOT/scripts/perf/garage-vehicle-server.sh" > "$LOGS/server.log" 2>&1 &
  STARTED+=($!); OWN_PORTS+=(4001)
fi
wait_for "http://127.0.0.1:4001/healthz" 1800 "the city server"

if listening 3003; then
  echo "demo: a web client is already on :3003; using it"
else
  (cd "$ROOT/client" && exec npx vite --port 3003 --strictPort) > "$LOGS/client.log" 2>&1 &
  STARTED+=($!); OWN_PORTS+=(3003)
fi
wait_for "http://127.0.0.1:3003/" 120 "the web client"

echo
echo "  browser: http://localhost:3003/city?match=$MATCH"
echo "  server:  http://127.0.0.1:4001/session-config?match_id=$MATCH"
echo

if [[ "$UNREAL" == 1 ]]; then
  "$ROOT/scripts/unreal/build-editor.sh" > "$LOGS/unreal-build.log" 2>&1 || { echo "demo: Unreal build failed; see $LOGS/unreal-build.log" >&2; exit 1; }
  "$UE_ROOT/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor" \
    "$ROOT/unreal/VibeCity/VibeCity.uproject" -game -windowed -ResX=1600 -ResY=900 \
    -VibeApi=http://127.0.0.1:4001 -VibeMatch="$MATCH" > "$LOGS/unreal.log" 2>&1 &
  STARTED+=($!)
  echo "demo: Unreal client starting (log: ~/Library/Logs/VibeCity/VibeCity.log)"
fi
echo "demo: running; Ctrl-C stops what this script started"
wait
