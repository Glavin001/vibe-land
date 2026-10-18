#!/bin/bash
# Play-test server for /city on the Mac: GPU PhysX + native destruction, built
# into target/play (never target/release, which other harnesses use), run on
# the default ports 4001/4002 under the GPU lock so benchmarks wait while
# someone plays. Stop it with Ctrl-C (or kill); the lock is released on exit.
#
#   scripts/perf/play-server.sh [--no-build]
#
# The client is the usual `npm run dev` in client/ (port 3003).
#
# VIBE_PHYSICS_BACKEND must be physx_gpu: without it the server falls back to
# Rapier with no city colliders, so shots, meteors and walls silently do
# nothing ("meteor aimed at nothing", physx_simulate_ms=0).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
export CARGO_TARGET_DIR="$ROOT/target/play"
if [ "${1:-}" != "--no-build" ]; then
  cargo build --release -p web-fps-server --features native-destruction --bin web-fps-server
fi
if lsof -nP -iTCP:4001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 4001 is already in use:" >&2
  lsof -nP -iTCP:4001 -sTCP:LISTEN >&2
  exit 1
fi
LOG="$ROOT/target/play/server-$(date +%Y%m%d-%H%M%S).log"
echo "server log: $LOG (waiting for the GPU lock if a benchmark holds it)"
exec scripts/perf/gpu-run.sh user-play env \
  VIBE_PHYSICS_BACKEND=physx_gpu RUST_LOG=${RUST_LOG:-info} \
  CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" \
  "$CARGO_TARGET_DIR/release/web-fps-server" > "$LOG" 2>&1
