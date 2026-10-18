#!/bin/bash
# Destruction correctness for garage vehicles on the garage's own path (see
# server/src/physx_runtime/vehicle_destruction_tests.rs): bond groups = rigid
# bodies, mass/COM, rigidity, gravity and free fall, rest, streaming, locality
# of shots, and no breaks at rest or while driving. Runs on the GPU under the
# GPU lock, so stop a running garage server first.
#
#   scripts/perf/garage-destruction-test.sh [--no-build]
#
# VIBE_VEHICLE_BUILD_FIXTURES (default target/vehicle-build-fixtures.json), from
#   cd client && node scripts/verify-vehicle-builds.mjs ../.cache/vehicle-assets ../target/vehicle-build-fixtures.json
# VIBE_NATIVE_FRAGMENT_GRAVITY=0 reproduces weightless debris (the tests must fail).
# VIBE_DESTRUCTION_MODELS (default buggy), VIBE_DESTRUCTION_SCENARIOS
# (rest,drive,shot...) narrow the run. The report lands in
# target/vehicle-destruction-report.json (VIBE_VEHICLE_DESTRUCTION_REPORT).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
SDK=${VIBE_VEHICLE_SDK:-$ROOT/../PhysX/out/install/garage-multihull}
VIBE_VEHICLE_BUILD_FIXTURES=${VIBE_VEHICLE_BUILD_FIXTURES:-$ROOT/target/vehicle-build-fixtures.json}
[ -f "$VIBE_VEHICLE_BUILD_FIXTURES" ] || { echo "no fixture manifest: (cd client && node scripts/verify-vehicle-builds.mjs ../.cache/vehicle-assets ../target/vehicle-build-fixtures.json)" >&2; exit 1; }
export PHYSX_ROOT="$SDK" CARGO_TARGET_DIR="$ROOT/target/garage-vehicles"
TEST=garage_vehicle_destruction_is_rigid_body_correct
if [ "${1:-}" != "--no-build" ]; then
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server --no-run
fi
exec scripts/perf/gpu-run.sh garage-destruction-test env \
  VIBE_VEHICLE_BUILD_FIXTURES="$VIBE_VEHICLE_BUILD_FIXTURES" CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
  cargo test --release -p web-fps-server --features native-destruction --bin web-fps-server \
  "$TEST" -- --ignored --nocapture --test-threads=1
