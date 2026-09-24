#!/bin/bash
# City benchmark: scripted headless players destroy /city while a paired
# client+server capture records it, then a report says whether server and
# clients stayed real-time and how well the netcode streamed it.
# See docs/city-bench.md.
#
#   scripts/perf/city-bench.sh [options]
#     --scenario NAME|PATH  client/e2e/city-bench/scenarios/<NAME>.json (default systematic)
#     --clients N           headless clients (default 1; client 0 plays, the rest spectate)
#     --buildings N         cap on buildings destroyed (default: the scenario's)
#     --intensity X         scales shots, meteors, demolition rounds (default 1)
#     --seed N              aim/demolition randomness (default: the scenario's)
#     --label NAME          run directory suffix (default: scenario-Nc)
#     --baseline FILE       report.json of an earlier run: print and record deltas
#     --budgets FILE        budgets (default scripts/perf/city-bench/budgets.json)
#     --no-build            use the existing server binary as is
#     --analyse DIR         only (re)analyse an existing run directory
#
# Output: target/city-bench/runs/<date>-<label>/ (report.md, report.json,
# bundles, logs). Ports: server 127.0.0.1:4301 + WebTransport :4302, client
# dev server :3303 (HTTP_PORT, WT_PORT, CLIENT_PORT override them; the output
# root is CITY_BENCH_OUT). The GPU lock (scripts/perf/gpu-run.sh) is held only while
# the server and the browsers run; building and analysis happen outside it.
# Exit status: 0 all budgets pass, 1 a budget failed, >1 the run failed.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT_ROOT=${CITY_BENCH_OUT:-/Users/glavin/Development/vibe-land/target/city-bench}
SCENARIO=systematic; CLIENTS=1; BUILDINGS=""; INTENSITY=""; SEED=""; LABEL=""; BASELINE=""
BUDGETS="$ROOT/scripts/perf/city-bench/budgets.json"; BUILD=1; ANALYSE_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO=$2; shift 2 ;;
    --clients) CLIENTS=$2; shift 2 ;;
    --buildings) BUILDINGS=$2; shift 2 ;;
    --intensity) INTENSITY=$2; shift 2 ;;
    --seed) SEED=$2; shift 2 ;;
    --label) LABEL=$2; shift 2 ;;
    --baseline) BASELINE=$2; shift 2 ;;
    --budgets) BUDGETS=$2; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --analyse) ANALYSE_ONLY=$2; shift 2 ;;
    -h|--help) sed -n 2,26p "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done

analyse() {
  local dir=$1
  local args=("$dir" --budgets "$BUDGETS")
  [ -n "$BASELINE" ] && args+=(--baseline "$BASELINE")
  python3 "$ROOT/scripts/perf/city-bench/report.py" "${args[@]}"
}
if [ -n "$ANALYSE_ONLY" ]; then analyse "$ANALYSE_ONLY"; exit $?; fi

case "$SCENARIO" in
  */*|*.json) SCENARIO_PATH=$(cd "$(dirname "$SCENARIO")" && pwd)/$(basename "$SCENARIO") ;;
  *) SCENARIO_PATH="$ROOT/client/e2e/city-bench/scenarios/$SCENARIO.json" ;;
esac
[ -f "$SCENARIO_PATH" ] || { echo "no scenario $SCENARIO_PATH" >&2; exit 64; }
NAME=$(basename "$SCENARIO_PATH" .json)
LABEL=${LABEL:-$NAME-${CLIENTS}c}
STAMP=$(date +%Y%m%d-%H%M%S)
RUN_DIR="$OUT_ROOT/runs/$STAMP-$LABEL"
mkdir -p "$RUN_DIR"
exec > >(tee -a "$RUN_DIR/bench.log") 2>&1
echo "city-bench $LABEL -> $RUN_DIR"

export CARGO_TARGET_DIR="$OUT_ROOT/cargo"
export PHYSX_DESTRUCTION_SDK=${PHYSX_DESTRUCTION_SDK:-/Users/glavin/Development/PhysX}
export PHYSX_ROOT=${PHYSX_ROOT:-$PHYSX_DESTRUCTION_SDK/out/install/macos-cumetal/release}
BIN="$CARGO_TARGET_DIR/release/web-fps-server"
if [ "$BUILD" = 1 ]; then
  echo "building the server (release, native-destruction) into $CARGO_TARGET_DIR"
  (cd "$ROOT" && cargo build --release -p web-fps-server --features native-destruction --bin web-fps-server) \
    > "$RUN_DIR/cargo-build.log" 2>&1 || { echo "FAIL: server build; see $RUN_DIR/cargo-build.log" >&2; tail -20 "$RUN_DIR/cargo-build.log"; exit 10; }
fi
[ -x "$BIN" ] || { echo "FAIL: no server binary at $BIN" >&2; exit 10; }
if [ ! -d "$ROOT/client/src/wasm/pkg" ] || [ ! -d "$ROOT/client/src/wasm/debris-pkg" ]; then
  echo "building the client wasm packages"
  (cd "$ROOT/client" && CARGO_TARGET_DIR="$OUT_ROOT/wasm-cargo" \
    CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/clang AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm@21/bin/llvm-ar \
    npm run build:wasm) > "$RUN_DIR/wasm-build.log" 2>&1 || { echo "FAIL: wasm build; see $RUN_DIR/wasm-build.log" >&2; exit 10; }
fi

export HTTP_PORT=${HTTP_PORT:-4301} WT_PORT=${WT_PORT:-4302} CLIENT_PORT=${CLIENT_PORT:-3303}
VITE=""
cleanup() {
  if [ -n "$VITE" ]; then kill "$VITE" 2>/dev/null; pkill -P "$VITE" 2>/dev/null; fi
}
trap cleanup EXIT
if curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null; then
  echo "FAIL: something already answers on :$CLIENT_PORT" >&2; exit 11
fi
(cd "$ROOT/client" && CLIENT_PORT=$CLIENT_PORT SERVER_PORT=$HTTP_PORT SERVER_HOST=127.0.0.1 \
  VITE_CACHE_DIR="$OUT_ROOT/vite-cache" exec npx vite --config e2e/city-bench/vite.bench.config.ts \
  --port "$CLIENT_PORT" --strictPort) > "$RUN_DIR/vite.log" 2>&1 &
VITE=$!
for _ in $(seq 1 60); do curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null && break; sleep 1; done
curl -s -m 2 "http://localhost:$CLIENT_PORT/" >/dev/null || { echo "FAIL: client dev server did not start; see $RUN_DIR/vite.log" >&2; exit 11; }
# Compile the /city page once before the lock so the first join is not a cold build.
curl -s -m 120 "http://localhost:$CLIENT_PORT/city" >/dev/null

export BIN RUN_ID="$STAMP-$LABEL" SCENARIO="$SCENARIO_PATH" CLIENTS
[ -n "$BUILDINGS" ] && export BUILDINGS
[ -n "$INTENSITY" ] && export INTENSITY
[ -n "$SEED" ] && export SEED
# The machine-wide lock lives in the main checkout (a worktree's own copy of
# gpu-run.sh would lock a different directory).
GPU_RUN=${GPU_RUN:-/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh}
echo "waiting for the GPU lock (owner: $(cat "$(dirname "$GPU_RUN")/../../target/perf-tools/gpu.lock/owner" 2>/dev/null || echo none))"
"$GPU_RUN" "city-bench-$LABEL" "$ROOT/scripts/perf/city-bench/locked.sh" "$RUN_DIR"
RUN_CODE=$?
cleanup; VITE=""
if [ "$RUN_CODE" != 0 ]; then
  echo "FAIL: the run exited $RUN_CODE; see $RUN_DIR/driver.log and $RUN_DIR/server.log" >&2
  [ -f "$RUN_DIR/run.json" ] || exit 20
  echo "analysing what was recorded anyway"
fi
analyse "$RUN_DIR"; A=$?
[ "$RUN_CODE" != 0 ] && exit 20
exit $A
