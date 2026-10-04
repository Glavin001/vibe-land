#!/bin/bash
# Opt-in destructible garage vehicles (WIP). Builds against the separate vehicle
# PhysX install (not the live perf install), into target/garage-vehicles, and
# runs with VIBE_GARAGE_VEHICLE_DESTRUCTION=1 on the default ports 4001/4002
# under the GPU lock. /city on this server also uses that SDK.
#
#   scripts/perf/garage-vehicle-server.sh [--no-build]
#
# VIBE_GARAGE_BALL_MASS (kg) overrides the 30 kg cannonball for demos.
# /city fields destructible garage builds instead of its stock cars
# (VIBE_CITY_DESTRUCTIBLE_VEHICLES, default 1 = server/src/city_fleet.rs
# DEFAULT_FLEET here; a comma list of build ids picks others; 0 = stock cars).
# VIBE_GARAGE_STRESS_ITERATIONS caps stress iterations per tick (default 64).
# VIBE_VEHICLE_SDK selects the install (default: the float vehicle SDK).
# Float does not yet converge under Vehicle2 road loads, so this demo sets
# PX_DESTRUCTION_ALLOW_UNCONVERGED=1: unconverged stress steps are published
# instead of rejected (fracture verdicts may be spurious). Double precision is
# emulated on Apple GPUs (~0.5 s/tick) and is not usable for play.
# VIBE_NATIVE_STRESS_FORCE_TOLERANCE (default 1e-3 here): force convergence,
# PxDestructionStressDesc::forceTolerance (destruction/src/native_runtime.rs);
# 0 = the residual test alone.
# BLAST_STRESS_INCREMENTAL_MOTION=1, PX_DESTRUCTION_INCREMENTAL_TOPOLOGY=1 (PhysX
# opt-ins, default 1 here): a fracture rebuilds the stress motion forest and the
# cluster mass properties of the touched components only. On the city's
# meteor correction ticks, -6 ms median and -12 ms p90 (Metal, 2026-10-03).
# BLAST_STRESS_BALANCED_OPERATOR=1: the component stress solve splits each
# operator pass by bonds, not nodes, so a car's 40-bond hub no longer sets the
# pace (a car's iteration 82 -> 49 us).
# The client is `npm run dev`.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
SDK=${VIBE_VEHICLE_SDK:-$ROOT/../PhysX/out/install/garage-multihull}
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
  VIBE_GARAGE_BALL_MASS=${VIBE_GARAGE_BALL_MASS:-} PX_DESTRUCTION_ALLOW_UNCONVERGED=${PX_DESTRUCTION_ALLOW_UNCONVERGED:-1} \
  VIBE_CITY_DESTRUCTIBLE_VEHICLES=${VIBE_CITY_DESTRUCTIBLE_VEHICLES:-1} \
  VIBE_NATIVE_STRESS_FORCE_TOLERANCE=${VIBE_NATIVE_STRESS_FORCE_TOLERANCE:-0.001} \
  BLAST_STRESS_INCREMENTAL_MOTION=${BLAST_STRESS_INCREMENTAL_MOTION:-1} \
  PX_DESTRUCTION_INCREMENTAL_TOPOLOGY=${PX_DESTRUCTION_INCREMENTAL_TOPOLOGY:-1} \
  BLAST_STRESS_BALANCED_OPERATOR=${BLAST_STRESS_BALANCED_OPERATOR:-1} \
  CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
  "$CARGO_TARGET_DIR/release/web-fps-server" > "$LOG" 2>&1
