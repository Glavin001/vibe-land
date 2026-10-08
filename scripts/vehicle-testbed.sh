#!/usr/bin/env bash
# The vehicle test bed, headless (server/src/vehicle_testbed.rs): every fleet
# build through structures/vehicle-lab's trials inside the real city stage on
# the GPU, then judged against structures/vehicle-lab/criteria.mjs.
#
#   scripts/vehicle-testbed.sh [--build monster[,desert]] [--trials debris,wall] [--label NAME] [--scene town] [--report-only]
#
# --scene town runs the trials set in Vibe Town (trials.mjs `scene: 'town'`,
# e.g. the chase replay) instead of the lab's.
#
# Writes target/vehicle-testbed/NAME.json (measurements) and NAME-verdict.json
# (criteria table); prints the table. Exit 1 when a criterion fails (unless
# --report-only). Extra environment variables pass through (what-ifs:
# VIBE_VEHICLE_BUMP_STOP_RATIO=..., VIBE_TESTBED_TRACE=1, ...). Takes the GPU
# lock itself (scripts/perf/gpu-run.sh). The native app's version, with
# stills: scripts/native-mac.sh vehicle-lab.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cars="" trials="" label="report" report_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build|--cars) cars="$2"; shift 2 ;;
    --trials) trials="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --scene) export VIBE_TESTBED_SCENE="$2"; shift 2 ;;
    --report-only) report_only=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
lab="$ROOT/structures/vehicle-lab"
stale=0
for source in "$lab"/*.mjs; do [ "$lab/out/vehicle-lab.json" -nt "$source" ] || stale=1; done
[ -f "$lab/out/vehicle-lab.json" ] && [ "$stale" = 0 ] || node "$lab/build-lab.mjs"
export PHYSX_ROOT="${PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-multihull}"
# A versioned SDK (NAME -> NAME@<rev>, rebuild-garage-sdk.sh): this run keeps the
# revision it started on, however often the link moves.
PHYSX_ROOT=$(cd -P "$PHYSX_ROOT" 2>/dev/null && pwd || echo "$PHYSX_ROOT")
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/garage-vehicles}"
(cd "$ROOT" && cargo test --release -p web-fps-server --features native-destruction --lib --no-run 2>&1 | grep -E '^error' -A12 || true)
log="$ROOT/target/vehicle-testbed/$label.log"
mkdir -p "$ROOT/target/vehicle-testbed"
(cd "$ROOT" && "$ROOT/scripts/perf/gpu-run.sh" testbed env CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
  ${cars:+VIBE_TESTBED_CARS=$cars} ${trials:+VIBE_TESTBED_TRIALS=$trials} VIBE_TESTBED_LABEL="$label" \
  cargo test --release -p web-fps-server --features native-destruction --lib vehicle_testbed -- --ignored --nocapture --test-threads=1) \
  > "$log" 2>&1 || { grep -E 'panicked|error' -A6 "$log" | head -40; echo "test bed FAILED (log: $log)" >&2; exit 1; }
grep -E '^[a-z]+ +[a-z0-9-]+ +[0-9.]+ m/s|first breaks' "$log" || true
args=("$ROOT/target/vehicle-testbed/$label.json")
[ "$report_only" = 1 ] && args+=(--report-only)
node "$lab/report.mjs" "${args[@]}"
