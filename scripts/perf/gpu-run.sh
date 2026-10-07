#!/bin/bash
# Run a GPU job under this machine's GPU admission: scripts/perf/gpu-run.sh <label> <command...>
#
# Two kinds of job share one Apple GPU:
# - Timing work (profiling, perf A/B, benchmarks) takes the exclusive lock and
#   waits until no other GPU job is running, so its numbers are clean.
# - Correctness runs (tests, trials, qualification, films) set
#   VIBE_GPU_SHARED=1 and take one of VIBE_GPU_SLOTS slots (default 3). They
#   run concurrently, but only that many at once: fifteen at once only queue
#   on the GPU, crawl, and trip the Metal watchdog
#   (kIOGPUCommandBufferCallbackErrorTimeout) for everyone.
#
# The locks are machine-wide (VIBE_GPU_LOCK_DIR, default under ~/Library/Caches),
# not per checkout, so worktrees and the main checkout share them. Call this
# script by its path in the main checkout. A lock or slot whose owner has exited
# is reclaimed.
DIR="${VIBE_GPU_LOCK_DIR:-$HOME/Library/Caches/vibe-land-gpu}"
SLOTS="${VIBE_GPU_SLOTS:-3}"
LOCK="$DIR/exclusive"
mkdir -p "$DIR"
label=$1; shift

stale() { # stale <lockdir>: its owner process has exited
  local owner pid
  owner=$(cat "$1/owner" 2>/dev/null) || return 1
  pid=${owner%% *}
  [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null
}

held=""
release() { [ -n "$held" ] && rm -rf "$held"; }
trap release EXIT
trap 'release; exit 130' INT TERM

if [ "${VIBE_GPU_SHARED:-0}" = 1 ]; then
  # A shared job waits while timing work holds the GPU, then takes a free slot.
  while [ -z "$held" ]; do
    if [ -d "$LOCK" ]; then stale "$LOCK" && rm -rf "$LOCK"; sleep 2; continue; fi
    for i in $(seq 1 "$SLOTS"); do
      slot="$DIR/slot-$i"
      if mkdir "$slot" 2>/dev/null; then
        echo "$$ $label $(date +%H:%M:%S)" > "$slot/owner"; held=$slot; break
      fi
      stale "$slot" && rm -rf "$slot"
    done
    [ -z "$held" ] && sleep 2
  done
else
  until mkdir "$LOCK" 2>/dev/null; do
    stale "$LOCK" && { rm -rf "$LOCK"; continue; }
    sleep 2
  done
  echo "$$ $label $(date +%H:%M:%S)" > "$LOCK/owner"; held=$LOCK
  # Timing work also waits for the shared jobs already running to finish.
  while :; do
    busy=0
    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      if stale "$slot"; then rm -rf "$slot"; else busy=1; fi
    done
    [ "$busy" = 0 ] && break
    sleep 2
  done
fi
"$@"
