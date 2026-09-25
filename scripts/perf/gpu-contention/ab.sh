#!/bin/bash
# GPU-contention A/B: perf_bench's `meteor` scenario (the 2026-09-24 session's
# first two meteors) alone, and while another GPU client renders beside it.
# The whole plan runs under ONE hold of the machine-wide GPU lock, so arms are
# interleaved back to back and no other job lands between them. Uses the GPU.
#
#   scripts/perf/gpu-contention/ab.sh <out_dir> <arm> [<arm> ...]
#
# Arms (a label may carry a suffix, e.g. A.1 B.2; everything after the first
# dot is ignored when choosing what to run):
#   A           the bench alone
#   B           + headless Chromium playing the session tape via /cityreplay
#               (client-load.mjs) at the user's window: 2844x2275 CSS px, dpr 0.9
#               (rendered at 2844x2275 px: R3F's dpr floor is 1).
#               Headless Chromium's own frame pacing here is ~120 Hz (measured).
#   Bunc        as B, Chromium without its frame limit (--disable-frame-rate-limit)
#   B60 / B30   as B with the opt-in client cap ?maxFps=60 / ?maxFps=30
#   B120        as Bunc with ?maxFps=120
#   Bsmall      as B at 1280x720, dpr 1
#   Bsmall60    as Bsmall with ?maxFps=60; Bsmall30 with ?maxFps=30
#   Buser       the user's live canvas: 2844x2275 CSS px, dpr 0.9, render dpr capped at
#               0.54 (0.9 zoom x the governor's 0.6 floor seen in the session's debug
#               reports) via the dprCap setting: 1536x1229 px. (R3F's dpr floor is 1, so
#               B at dpr 0.9 renders 2844x2275 px.)
#   Buser30     as Buser with ?maxFps=30
#   C<ms>       + metal-load --kind render --busy-ms <ms> --hz 60 (e.g. C8)
#   K<ms>       + metal-load --kind compute --busy-ms <ms> --hz 60
#   L<arm>      the load of <arm> alone for ${ALONE_S:-30} s, no bench (its own frame times)
#   <arm>_b     any arm with CUMETAL_BATCH_DISPATCHES=$BATCH (default 4096; CuMetal's
#               default is 256): fewer, larger command buffers on the server side
#
# Environment: BENCH_BIN (perf_bench test binary), DIST (vite build), TAPE,
# MANIFEST, METAL_LOAD (binary), EXTRA_BENCH_ENV (extra VAR=VALUE words for
# every bench run). Writes <out_dir>/<arm>/ (meteor_pair.csv, bench.log,
# client.json or load.csv, clock.txt, ps.txt) and <out_dir>/package.txt.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WT=$(cd "$HERE/../../.." && pwd)
ROOT=/Users/glavin/Development/vibe-land
OUT=${1:?out dir}; shift
[ $# -gt 0 ] || { echo "no arms" >&2; exit 64; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
BENCH_BIN=${BENCH_BIN:-$ROOT/target/meteor-bench/cargo/release/deps/web_fps_server-c88140cb4ccdc8ac}
DIST=${DIST:-$ROOT/target/gpu-contention/replay-dist}
TAPE=${TAPE:-$ROOT/debug-reports/session-20260924-213925-ondf3t/client.vltape}
MANIFEST=${MANIFEST:-$ROOT/target/tape-replay/run1/manifest-391bacd0d2033bc213bfe72b81bf3136692aaac73c22413870515afa15cc6723.bin}
METAL_LOAD=${METAL_LOAD:-$ROOT/target/gpu-contention/bin/metal-load}
export BENCH_BIN DIST TAPE MANIFEST METAL_LOAD

if [ -z "${GPU_CONTENTION_LOCKED:-}" ]; then
  PHYSX_LIB=/Users/glavin/Development/PhysX/out/install/macos-cumetal/release/lib
  {
    echo "date=$(date '+%F %T')"
    echo "worktree=$WT git=$(git -C "$WT" rev-parse --short HEAD) dirty_files=$(git -C "$WT" status --short | wc -l | tr -d ' ')"
    echo "physx_git=$(git -C /Users/glavin/Development/PhysX log -1 --format=%h 2>/dev/null)"
    echo "cuda_metal_git=$(git -C /Users/glavin/Development/cuda-metal log -1 --format=%h 2>/dev/null)"
    echo "libcumetal=$(stat -f '%Sm %z' "$PHYSX_LIB/libcumetal.dylib") sha=$(shasum -a 256 "$PHYSX_LIB/libcumetal.dylib" | cut -c1-16)"
    echo "bench_bin=$BENCH_BIN sha=$(shasum -a 256 "$BENCH_BIN" | cut -c1-16)"
    echo "dist=$DIST index_sha=$(shasum -a 256 "$DIST/index.html" | cut -c1-16)"
    echo "tape=$TAPE"
    echo "arms=$*"
  } > "$OUT/package.txt"
  echo "waiting for the GPU lock (owner: $(cat "$ROOT/target/perf-tools/gpu.lock/owner" 2>/dev/null || echo none))"
  GPU_CONTENTION_LOCKED=1 exec "$ROOT/scripts/perf/gpu-run.sh" gpu-contention "$HERE/ab.sh" "$OUT" "$@"
fi

echo "lock held at $(date +%H:%M:%S); nice $(ps -o nice= -p $$)"
LOAD_PID=""
stop_load() {
  if [ -n "$LOAD_PID" ]; then
    touch "$STOP"
    for _ in $(seq 1 60); do kill -0 "$LOAD_PID" 2>/dev/null || break; sleep 0.5; done
    kill "$LOAD_PID" 2>/dev/null; pkill -P "$LOAD_PID" 2>/dev/null
    wait "$LOAD_PID" 2>/dev/null
    LOAD_PID=""
  fi
}
trap stop_load EXIT
mono_ms() { python3 -c 'import time; print(f"{time.clock_gettime_ns(time.CLOCK_UPTIME_RAW)/1e6:.3f} {time.time()*1000:.3f}")'; }

run_arm() {
  local label=$1 arm=${1%%.*}
  local -a benv=()
  local alone=""
  if [ "${arm:0:1}" = L ]; then alone=1; arm=${arm#L}; fi
  if [ "${arm%_b}" != "$arm" ]; then arm=${arm%_b}; benv=(CUMETAL_BATCH_DISPATCHES=${BATCH:-4096}); fi
  local dir="$OUT/$label"
  mkdir -p "$dir"
  READY="$dir/ready"; STOP="$dir/stop"; rm -f "$READY" "$STOP"
  local -a load=()
  local -a cenv=()
  case "$arm" in
    A) ;;
    B) cenv=() ;;
    Bunc) cenv=(UNCAPPED=1) ;;
    B60) cenv=(MAXFPS=60) ;;
    B30) cenv=(MAXFPS=30) ;;
    Bsmall60) cenv=(W=1280 H=720 DPR=1 MAXFPS=60) ;;
    Bsmall30) cenv=(W=1280 H=720 DPR=1 MAXFPS=30) ;;
    Buser) cenv=(LS='{"vibe.render.dprCap":"0.54"}') ;;
    Buser30) cenv=(LS='{"vibe.render.dprCap":"0.54"}' MAXFPS=30) ;;
    B120) cenv=(UNCAPPED=1 MAXFPS=120) ;;
    Bsmall) cenv=(W=1280 H=720 DPR=1) ;;
    C*) load=("$METAL_LOAD" --kind render --busy-ms "${arm#C}" --hz 60 --seconds 200 --out "$dir/load.csv" --ready "$READY" --stop "$STOP") ;;
    K*) load=("$METAL_LOAD" --kind compute --busy-ms "${arm#K}" --hz 60 --seconds 200 --out "$dir/load.csv" --ready "$READY" --stop "$STOP") ;;
    *) echo "unknown arm $arm" >&2; return 2 ;;
  esac
  if [ "${arm:0:1}" = B ]; then
    load=(env "${cenv[@]+"${cenv[@]}"}" OUT="$dir/client.json" READY="$READY" STOP="$STOP" node "$HERE/client-load.mjs")
  fi
  echo "== $label ($(date +%H:%M:%S)) ${benv[*]+${benv[*]}} ${load[*]+${load[*]}}"
  if [ ${#load[@]} -gt 0 ]; then
    (cd "$WT/client" && exec "${load[@]}") > "$dir/load.log" 2>&1 &
    LOAD_PID=$!
    local waited=0
    until [ -f "$READY" ]; do
      kill -0 "$LOAD_PID" 2>/dev/null || { echo "load exited before READY"; tail -5 "$dir/load.log"; LOAD_PID=""; return 3; }
      sleep 0.5; waited=$((waited + 1))
      [ $waited -gt 480 ] && { echo "load not READY in 240 s"; stop_load; return 3; }
    done
    sleep 3
  fi
  ps -axo pid,nice,%cpu,command | grep -E 'web-fps-server|web_fps_server|chrome-headless|metal-load|WindowServer|cargo|rustc|swiftc' | grep -v grep | cut -c1-160 > "$dir/ps.txt"
  echo "bench_start $(mono_ms)" > "$dir/clock.txt"
  if [ -n "$alone" ]; then
    sleep "${ALONE_S:-30}"
    echo "bench_end $(mono_ms)" >> "$dir/clock.txt"
    stop_load
    return 0
  fi
  (cd "$WT/server" && env VIBE_PERF_SCENARIOS=meteor VIBE_PERF_ALL_TICKS=1 VIBE_PERF_PACE=1 VIBE_PHYSX_PROFILE=1 \
    VIBE_PERF_MARKERS=1 VIBE_PERF_TRACE_DIR="$dir" CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" \
    ${benv[@]+"${benv[@]}"} ${EXTRA_BENCH_ENV:-} "$BENCH_BIN" perf_bench --ignored --nocapture --test-threads=1) > "$dir/bench.log" 2>&1 \
    || echo "bench exited $?"
  echo "bench_end $(mono_ms)" >> "$dir/clock.txt"
  stop_load
  grep -E '^PERF ' "$dir/bench.log" || true
}

for label in "$@"; do run_arm "$label"; done
echo "done at $(date +%H:%M:%S)"
