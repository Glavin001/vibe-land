#!/bin/bash
# Meteor-impact step profile: perf_bench's `meteor` scenario (the live
# session's first two meteors replayed with their logged start and velocity)
# and `fracture_warm` (six cannonballs) for comparison, under the machine-wide
# GPU lock. Uses the GPU.
#
#   scripts/perf/tape-analysis/meteor-bench.sh <out_dir> [arm ...]
#
# Arms (default: warmup timing zones commits small nocorrect):
#   warmup     one untimed meteor pass first (pipeline cache, GPU clocks); discard it
#   timing     paced 60 Hz, every tick (VIBE_PERF_ALL_TICKS=1), no engine zones
#   zones      as timing, plus the engine's own zones (VIBE_PHYSX_PROFILE=1)
#   commits    meteor only, CUMETAL_TRACE_COMMITS=1 + CUMETAL_TRACE_SYNC=1 (cuda-metal 780264d or
#              later; older packages ignore it) + step markers + compile trace
#              (tracing un-batches nothing but prints a line per command buffer;
#              for attribution, not timing)
#   small      meteor only, a 1 m rock (VIBE_CITY_METEOR_RADIUS_M=1, 13.8 t), same velocity
#   nocorrect  meteor only, VIBE_CITY_NATIVE_CORRECTION_LIMIT=0 (no corrected re-solve)
#
# Build first (CPU only), into your own target dir:
#   CARGO_TARGET_DIR=<dir> PHYSX_ROOT=/Users/glavin/Development/PhysX/out/install/macos-cumetal/release \
#     cargo test -p web-fps-server --release --no-default-features --features native-destruction perf_bench --no-run
# then pass the test binary as BENCH_BIN=<path to deps/web_fps_server-*>.
set -euo pipefail
OUT=${1:?out dir}; shift
ARMS=${*:-warmup timing zones commits small nocorrect}
BIN=${BENCH_BIN:?set BENCH_BIN to the perf_bench test binary}
ROOT=/Users/glavin/Development/vibe-land
# cargo test runs a test binary from its package directory; the scenes load assets relative to it.
WT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GPU_RUN=${GPU_RUN:-$ROOT/scripts/perf/gpu-run.sh}
mkdir -p "$OUT"
run_arm() {
  local arm=$1
  local scenarios="fracture_warm,meteor"
  local -a extra=()
  case "$arm" in
    warmup) scenarios=meteor ;;
    timing) ;;
    zones) extra=(VIBE_PHYSX_PROFILE=1) ;;
    commits) scenarios=meteor; extra=(CUMETAL_TRACE_COMMITS=1 CUMETAL_TRACE_SYNC=1 CUMETAL_TRACE_COMPILE=1 VIBE_PERF_MARKERS=1) ;;
    small) scenarios=meteor; extra=(VIBE_CITY_METEOR_RADIUS_M=1) ;;
    nocorrect) scenarios=meteor; extra=(VIBE_CITY_NATIVE_CORRECTION_LIMIT=0) ;;
    *) echo "unknown arm $arm" >&2; return 2 ;;
  esac
  echo "== $arm ($(date +%H:%M:%S))"
  cd "$WT/server"
  env VIBE_PERF_SCENARIOS=$scenarios VIBE_PERF_ALL_TICKS=1 VIBE_PERF_PACE=1 \
    VIBE_PERF_TRACE_DIR="$OUT/$arm" CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" \
    ${extra[@]+"${extra[@]}"} "$BIN" perf_bench --ignored --nocapture --test-threads=1 \
    > "$OUT/$arm.log" 2>&1 || echo "arm $arm exited $?"
  grep -E '^(PERF|METEOR) ' "$OUT/$arm.log" || true
}
export -f run_arm
export OUT BIN ROOT WT
for arm in $ARMS; do mkdir -p "$OUT/$arm"; done
# Which package the results come from: the test binary loads libcumetal from the PhysX install.
PHYSX_LIB=/Users/glavin/Development/PhysX/out/install/macos-cumetal/release/lib
{
  echo "physx_git=$(git -C /Users/glavin/Development/PhysX log -1 --format=%h 2>/dev/null)"
  echo "libcumetal=$(stat -f '%Sm %z' "$PHYSX_LIB/libcumetal.dylib")"
  echo "libcumetal_has_trace_sync=$(strings "$PHYSX_LIB/libcumetal.dylib" | grep -c '^CUMETAL_TRACE_SYNC$')"
  echo "bench_bin=$BIN"
} > "$OUT/package.txt"
echo "waiting for the GPU lock (owner: $(cat "$ROOT/target/perf-tools/gpu.lock/owner" 2>/dev/null || echo none))"
"$GPU_RUN" meteor-analysis bash -c "for arm in $ARMS; do run_arm \$arm; done"
