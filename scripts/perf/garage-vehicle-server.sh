#!/bin/bash
# Opt-in destructible garage vehicles (WIP). Builds against the separate vehicle
# PhysX install (not the live perf install), into target/garage-vehicles, and
# runs with VIBE_GARAGE_VEHICLE_DESTRUCTION=1 on the default ports 4001/4002
# under the GPU lock. /city on this server also uses that SDK.
#
#   scripts/perf/garage-vehicle-server.sh [--no-build]
#
# VIBE_VEHICLE_SDK selects the install (default: the temporary FP64 stress
# runtime, until float converges under road loads; see
# docs/reports/vehicle-wheel-colliders-2026-09-26). The client is `npm run dev`.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
SDK=${VIBE_VEHICLE_SDK:-$ROOT/../PhysX/out/install/garage-multihull-fp64}
[ -f "$SDK/include/physx/PxDestructionScene.h" ] || { echo "vehicle SDK not found: $SDK" >&2; exit 1; }
export PHYSX_ROOT="$SDK" CARGO_TARGET_DIR="$ROOT/target/garage-vehicles"
if [ "${1:-}" != "--no-build" ]; then
  cargo build --release -p web-fps-server --features native-destruction --bin web-fps-server
fi
if lsof -nP -iTCP:4001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 4001 is already in use:" >&2
  lsof -nP -iTCP:4001 -sTCP:LISTEN >&2
  exit 1
fi
LOG="$CARGO_TARGET_DIR/server-$(date +%Y%m%d-%H%M%S).log"
echo "server log: $LOG (SDK $SDK)"
exec scripts/perf/gpu-run.sh garage-vehicles env \
  VIBE_PHYSICS_BACKEND=physx_gpu VIBE_GARAGE_VEHICLE_DESTRUCTION=1 RUST_LOG=${RUST_LOG:-info} \
  CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
  "$CARGO_TARGET_DIR/release/web-fps-server" > "$LOG" 2>&1
