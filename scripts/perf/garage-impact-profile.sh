#!/bin/bash
# Where the meteor impact tick's time goes (garage_meteor_impact_tick_profile
# in server/src/physx_runtime/vehicle_destruction_tests.rs): one garage scene
# per meteor seed, every step timed, PhysX zones per tick. Runs on the GPU
# under the GPU lock, so stop a running garage server first.
#
#   scripts/perf/garage-impact-profile.sh [--no-build]
#
# VIBE_PROFILE_SEEDS (default 7,1,2,3,4,5), VIBE_PROFILE_HOLD_TICKS (default 240
# ticks after impact), VIBE_PROFILE_PACE (1: step on a 60 Hz clock like the server; spin: busy-wait)
# and VIBE_PROFILE_TERRAIN (default 1,
# the garage heightfield). Rows and a per-seed summary land in
# target/meteor-tick-profile.json. PX_DESTRUCTION_LOG_GRAPH_GROWTH=1 logs every
# destruction storage growth.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
SDK=${VIBE_VEHICLE_SDK:-$ROOT/../PhysX/out/install/garage-multihull}
VIBE_VEHICLE_BUILD_FIXTURES=${VIBE_VEHICLE_BUILD_FIXTURES:-$ROOT/target/vehicle-build-fixtures.json}
export PHYSX_ROOT="$SDK" CARGO_TARGET_DIR="$ROOT/target/garage-vehicles"
if [ "${1:-}" != "--no-build" ]; then
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server --no-run
fi
exec scripts/perf/gpu-run.sh garage-impact-profile env \
  VIBE_VEHICLE_BUILD_FIXTURES="$VIBE_VEHICLE_BUILD_FIXTURES" CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
  PX_DESTRUCTION_ALLOW_UNCONVERGED=${PX_DESTRUCTION_ALLOW_UNCONVERGED:-1} \
  VIBE_PROFILE_SEEDS=${VIBE_PROFILE_SEEDS:-7,1,2,3,4,5} VIBE_PROFILE_HOLD_TICKS=${VIBE_PROFILE_HOLD_TICKS:-240} VIBE_PROFILE_PACE=${VIBE_PROFILE_PACE:-0} VIBE_PROFILE_TERRAIN=${VIBE_PROFILE_TERRAIN:-1} \
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server \
  garage_meteor_impact_tick_profile -- --ignored --nocapture --test-threads=1
