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

# A lock's owner file records "pid label time started", where started is the
# owner's process start time (ps lstart). A pid alone is not enough: after the
# owner dies (a session restart), macOS can hand its pid to an unrelated
# process, and the slot would look held forever.
started() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' '_'; }
stale() { # stale <lockdir>: its owner process has exited
  local owner pid start
  owner=$(cat "$1/owner" 2>/dev/null) || return 1
  pid=${owner%% *}
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 0
  start=$(echo "$owner" | awk '{print $4}')
  [ -n "$start" ] && [ "$start" != "$(started "$pid")" ]
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
        echo "$$ $label $(date +%H:%M:%S) $(started $$)" > "$slot/owner"; held=$slot; break
      fi
      stale "$slot" && rm -rf "$slot"
    done
    [ -z "$held" ] && sleep 2
  done
else
  # Timing work waits for the GPU to be idle BEFORE it claims the lock, so a
  # long correctness run doesn't leave a pending timing job blocking every other
  # shared job behind it (it did: a trial running for an hour starved the rest).
  # Correctness comes first; timing takes the GPU when it is free.
  slots_busy() {
    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      if stale "$slot"; then rm -rf "$slot"; else return 0; fi
    done
    return 1
  }
  while :; do
    while slots_busy; do sleep 2; done
    if mkdir "$LOCK" 2>/dev/null; then break; fi
    stale "$LOCK" && rm -rf "$LOCK"
    sleep 2
  done
  echo "$$ $label $(date +%H:%M:%S) $(started $$)" > "$LOCK/owner"; held=$LOCK
  # A shared job may have started between the check and the claim: wait it out.
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
