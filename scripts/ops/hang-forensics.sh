#!/bin/bash
# Run the native app (or its physics alone) with everything recorded that is
# needed to name the cause of a desktop hang from ONE occurrence, and collect
# the rest after a logout.
#
#   scripts/ops/hang-forensics.sh run [--physics-only] [--scene town] [--profile high]
#                                     [--seconds 300] [--cpu-load N] [--no-guard] [--one-kernel-per-buffer]
#   scripts/ops/hang-forensics.sh collect [DIR]     # after logging back in (default: the latest run)
#   scripts/ops/hang-forensics.sh analyze [DIR]     # re-print the summary
#
# Everything goes to ~/Library/Logs/vibe-land/hang-forensics/<UTC time>/ (and
# .../latest), outside any checkout, written as it happens so it survives the
# process being killed by a logout:
#   app.log        the app's output, with CuMetal's per-command-buffer trace:
#                  CUMETAL_SUBMIT when a command buffer is committed (with its
#                  kernels) and CUMETAL_COMMIT when it completes (with its GPU
#                  times, status and error). The last SUBMIT with no COMMIT is
#                  the GPU work that never finished. CUMETAL_TRACE_SYNC: every
#                  host wait on the GPU.
#   trace.log      VIBE_HANG_TRACE: each PhysX step's simulate/fetch phases
#                  (physx_bridge.cc) and each render frame's WebGPU submission
#                  and completion (client/src/native/renderTrace.ts).
#   samples.tsv    every 0.5 s (hang_sampler.py): WindowServer's answer time,
#                  GPU utilisation, GPU memory, GPU resets (recoveryCount), the
#                  app's CPU and memory, load, the busiest processes; when
#                  WindowServer is slow, the app's thread stacks (sample-*.txt).
#   unified-stream.log  the macOS log (kernel, WindowServer, GPU and Metal) live.
#   meta.txt       revisions, SDK and CuMetal provenance, macOS, both clocks.
# `collect` adds reports/ (WindowServer and app DiagnosticReports since the
# start), unified.log (the macOS log for the run's window, which persists
# across a logout) and summary.txt (hang_analyze.py): which command buffer,
# which kernels, which PhysX phase, which render frame, and what else the
# machine was doing at the onset.
#
# The SDK is the diagnostic one (HANG_SDK, default garage-diag: PhysX
# fix/bounded-root-walk, whose union-find walks trap instead of looping, built
# on CuMetal diag/submit-trace). --physics-only runs sim-native's city-headless
# (the app's city, app defaults and PhysX build, no renderer, no window).
# --one-kernel-per-buffer (CUMETAL_BATCH_DISPATCHES=1): each kernel its own
# command buffer, so the one never completed is exactly one kernel; it changes
# the GPU timing, so use it on a second reproduction, not the first.
# --cpu-load N runs N busy processes beside it: both hangs on 2026-10-10 came
# with the machine loaded, and the soak that passed ran idle.
# The WindowServer guard (scripts/ops/ws-guard.sh) stops the app if the desktop
# stops answering for HANG_GUARD_MS (4000; the sampler records stacks at 1000);
# --no-guard runs without it. Nothing here runs inside the app.
# Parsed whole before it runs ({ ...; exit; }).
{
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BASE="$HOME/Library/Logs/vibe-land/hang-forensics"
SDK_NAME=${HANG_SDK:-garage-diag}
SDK=/Users/glavin/Development/PhysX/out/install/$SDK_NAME
cmd=${1:-}; shift || true

analyze() { python3 "$ROOT/scripts/ops/hang_analyze.py" "$1"; }

collect() {
  local dir=${1:-$BASE/latest}
  dir=$(cd "$dir" && pwd -P) || { echo "no run at $dir" >&2; exit 1; }
  local start; start=$(sed -n 's/^start_local=//p' "$dir/meta.txt")
  mkdir -p "$dir/reports"
  # Reports written since the run started: the WindowServer watchdog's, the
  # app's, and any GPU restart.
  find /Library/Logs/DiagnosticReports "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -type f \
    -newer "$dir/start.stamp" \( -iname 'WindowServer*' -o -iname 'mystral*' -o -iname 'city-headless*' \
    -o -iname '*GPU*' -o -iname '*.spin' -o -iname '*watchdog*' -o -iname 'panic*' \) 2>/dev/null |
    while read -r f; do cp -p "$f" "$dir/reports/" 2>/dev/null; done
  if [ -n "$start" ]; then
    log show --style compact --start "$start" --end "$(date -j -v+0S '+%Y-%m-%d %H:%M:%S')" \
      --predicate 'process == "kernel" OR process == "WindowServer" OR process == "loginwindow" OR subsystem BEGINSWITH "com.apple.Metal" OR subsystem BEGINSWITH "com.apple.gpu" OR subsystem BEGINSWITH "com.apple.SkyLight" OR process == "mystral" OR process == "city-headless"' \
      > "$dir/unified.log" 2>/dev/null
  fi
  echo "collected into $dir"
  analyze "$dir"
}

case "$cmd" in
  collect) collect "${1:-}"; exit 0 ;;
  analyze) analyze "${1:-$BASE/latest}"; exit 0 ;;
  run) ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac

physics_only=0; scene=town; profile=high; seconds=300; cpu_load=0; guard=1; one_kernel=0
while [ $# -gt 0 ]; do
  case "$1" in
    --physics-only) physics_only=1; shift ;;
    --scene) scene=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    --seconds) seconds=$2; shift 2 ;;
    --cpu-load) cpu_load=$2; shift 2 ;;
    --no-guard) guard=0; shift ;;
    --one-kernel-per-buffer) one_kernel=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -d "$SDK" ] || { echo "no SDK at $SDK (HANG_SDK)" >&2; exit 1; }
if pgrep -x mystral >/dev/null || pgrep -x city-headless >/dev/null; then echo "the app is already running" >&2; exit 2; fi

dir="$BASE/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dir"; ln -sfn "$dir" "$BASE/latest"
touch "$dir/start.stamp"
probe_dir="$ROOT/scripts/ops/ws-probe"
if [ ! -x "$probe_dir/ws_probe" ] || [ "$probe_dir/ws_probe.c" -nt "$probe_dir/ws_probe" ]; then
  clang -O2 -o "$probe_dir/ws_probe" "$probe_dir/ws_probe.c" -framework CoreGraphics -framework CoreFoundation || exit 2
fi
{
  echo "start_local=$(date '+%Y-%m-%d %H:%M:%S')"
  echo "start_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  python3 -c 'import time; print(f"clocks epoch={time.time():.6f} uptime_s={time.monotonic():.6f}")'
  echo "mode=$([ $physics_only = 1 ] && echo physics-only || echo app) scene=$scene profile=$profile seconds=$seconds cpu_load=$cpu_load guard=$guard one_kernel_per_buffer=$one_kernel"
  echo "vibe-land=$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- . ':!client/node_modules' 2>/dev/null || echo -dirty)"
  echo "sdk=$(cd "$SDK" && pwd -P)"
  echo "cumetal=$(cat "$SDK/cumetal-revision" 2>/dev/null || echo unknown)"
  echo "macos=$(sw_vers -productVersion) $(sw_vers -buildVersion) $(sysctl -n machdep.cpu.brand_string)"
  echo "load_at_start=$(sysctl -n vm.loadavg)"
} > "$dir/meta.txt"
cat "$dir/meta.txt"

# The macOS log, live (kernel GPU messages, WindowServer, Metal).
log stream --style compact \
  --predicate 'process == "kernel" OR process == "WindowServer" OR subsystem BEGINSWITH "com.apple.Metal" OR subsystem BEGINSWITH "com.apple.gpu" OR process == "mystral" OR process == "city-headless"' \
  > "$dir/unified-stream.log" 2>&1 &
logger_pid=$!
loads=()
for _ in $(seq 1 "$cpu_load"); do (while :; do :; done) & loads+=($!); done

# The app's environment: the profile, the diagnostic SDK in its own sim tree,
# and the traces.
export HIGH_PHYSX_ROOT=$SDK RUNTIME_PHYSX_ROOT=$SDK
export VIBE_SIM_TARGET="$ROOT/target/native-sim-$SDK_NAME"
export CUMETAL_TRACE_COMMITS=1 CUMETAL_TRACE_SYNC=1 VIBE_HANG_TRACE="$dir/trace.log"
[ $one_kernel = 1 ] && export CUMETAL_BATCH_DISPATCHES=1
source "$ROOT/scripts/fidelity/$profile.env" > /dev/null
export PHYSX_ROOT=$SDK
if [ $physics_only = 1 ]; then
  launcher=("$ROOT/scripts/native-mac.sh" headless --scene "$scene" "$seconds")
else
  launcher=("$ROOT/scripts/native-mac.sh" run --scene "$scene")
fi
if [ $guard = 1 ]; then
  WS_GUARD_LIMIT_MS=${HANG_GUARD_MS:-4000} "$ROOT/scripts/ops/ws-guard.sh" "${launcher[@]}" > "$dir/app.log" 2>&1 &
else
  "${launcher[@]}" > "$dir/app.log" 2>&1 &
fi
runner=$!
# The sampler watches the app process itself once it exists (the build may take minutes).
app_pid=""
for _ in $(seq 1 1800); do
  app_pid=$(pgrep -x mystral || pgrep -x city-headless | head -1)
  [ -n "$app_pid" ] && break
  kill -0 "$runner" 2>/dev/null || break
  sleep 1
done
app_pid=$(echo "$app_pid" | head -1)
if [ -z "$app_pid" ]; then
  echo "the app never started (see $dir/app.log)"
else
  echo "app pid $app_pid; recording to $dir"
  python3 "$ROOT/scripts/ops/hang_sampler.py" "$dir" "$app_pid" 0.5 &
  sampler=$!
  start=$SECONDS
  while kill -0 "$app_pid" 2>/dev/null && [ $((SECONDS - start)) -lt "$seconds" ]; do sleep 1; done
  kill -0 "$app_pid" 2>/dev/null && { echo "time up after $seconds s: stopping the app"; pkill -TERM -x mystral; pkill -TERM -x city-headless; }
  wait "$sampler" 2>/dev/null
fi
wait "$runner" 2>/dev/null; echo "runner exit $?" >> "$dir/meta.txt"
for p in "${loads[@]+"${loads[@]}"}"; do kill "$p" 2>/dev/null; done
kill "$logger_pid" 2>/dev/null
collect "$dir"
exit 0
}
