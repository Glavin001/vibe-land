#!/bin/bash
# Run one GPU job at a time on this machine: scripts/perf/gpu-run.sh <label> <command...>
# Timing work on one Apple GPU is meaningless when two jobs overlap, so every
# profiling or GPU test run takes this lock. A lock whose owner has exited is
# reclaimed. The lock itself is runtime state and lives under target/.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
LOCK="$ROOT/target/perf-tools/gpu.lock"
mkdir -p "$(dirname "$LOCK")"
label=$1; shift
until mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/owner" 2>/dev/null); pid=${owner%% *}
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 2
done
echo "$$ $label $(date +%H:%M:%S)" > "$LOCK/owner"
trap 'rm -rf "$LOCK"' EXIT
"$@"
