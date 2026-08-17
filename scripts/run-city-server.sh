#!/usr/bin/env bash
#
# Run (or restart) the destructible-city server on a clean world.
#
# There is no in-place city reset: destructibles are created in the PhysX scene
# at startup and the bridge has no teardown for them, so the only way to get an
# undamaged city is a fresh process. That is what this script is for -- restart
# is the reset.
#
# It also records how the server died. A city server that segfaults under load
# looks identical to one that exited cleanly if you only check whether the
# process is gone; EXIT_STATUS in the log is what caught a SIGSEGV that a
# liveness check had been reporting as "server not running".
#
# Usage:
#   scripts/run-city-server.sh            # restart on the release build
#   scripts/run-city-server.sh --debug    # restart on the debug build
#   scripts/run-city-server.sh --status   # is it up, and how did the last one die
#   scripts/run-city-server.sh --stop
#
# Release is the default deliberately. Debug builds carry 10-20x overhead on
# every CPU phase of the tick, which is enough to make an in-budget server look
# hopelessly slow -- a profile taken from one sent this project chasing
# optimizations it did not need.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${VIBE_CITY_LOG:-/tmp/city-physx-server.log}"
PROFILE=release
ACTION=restart

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) PROFILE=debug; shift ;;
    --release) PROFILE=release; shift ;;
    --status) ACTION=status; shift ;;
    --stop) ACTION=stop; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

stop_server() {
  local stopped=0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" 2>/dev/null && stopped=1
  done < <(pgrep -x web-fps-server)
  if [[ $stopped -eq 1 ]]; then
    # Give the GPU scene a moment to release before a new process claims it.
    for _ in $(seq 1 20); do
      pgrep -x web-fps-server >/dev/null || break
      sleep 0.5
    done
    pgrep -x web-fps-server >/dev/null && pkill -9 -x web-fps-server
  fi
}

case "$ACTION" in
  stop)
    stop_server
    echo "stopped"
    exit 0
    ;;
  status)
    if pgrep -x web-fps-server >/dev/null; then
      echo "running (pid $(pgrep -x web-fps-server | tr '\n' ' '))"
    else
      echo "not running"
      # A non-zero status here is the difference between "it was shut down"
      # and "it crashed", which the process list alone cannot tell you.
      grep -h '^EXIT_STATUS=' "$LOG" 2>/dev/null | tail -1 || echo "EXIT_STATUS=(none recorded)"
    fi
    exit 0
    ;;
esac

BIN="$REPO_ROOT/target/$PROFILE/web-fps-server"
if [[ ! -x "$BIN" ]]; then
  echo "missing $PROFILE binary: $BIN" >&2
  # cuda-stress, not just destruction. Without it NVBLAST_ENABLE_CUDA_STRESS is
  # undefined, the CUDA stress path is compiled out, and the solver silently
  # runs on the CPU -- which cannot afford to converge. Measured on the dense
  # downtown: CPU broke 7,024 bonds where the GPU broke 3,283 on the same
  # scenario. The extra breakage is solver residual, not physics.
  echo "build it with: cargo build${PROFILE:+ --$PROFILE} -p web-fps-server --features cuda-stress" >&2
  exit 1
fi

stop_server

export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${LD_LIBRARY_PATH:+:}/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release"
export VIBE_PHYSICS_BACKEND="${VIBE_PHYSICS_BACKEND:-physx_gpu}"
export WT_STRICT_SNAPSHOT_DATAGRAMS="${WT_STRICT_SNAPSHOT_DATAGRAMS:-1}"
export BIND_ADDR="${BIND_ADDR:-127.0.0.1:4003}"
export WT_BIND_ADDR="${WT_BIND_ADDR:-0.0.0.0:4434}"
export WT_PUBLIC_URL="${WT_PUBLIC_URL:-https://209.121.195.117:40651}"
export WT_CERT_PEM="${WT_CERT_PEM:-$REPO_ROOT/.certs/page-cert.pem}"
export WT_KEY_PEM="${WT_KEY_PEM:-$REPO_ROOT/.certs/page-key.pem}"
# The dense downtown: 27 buildings, 24,105 chunks, 131x153 m, 84 m at the
# tallest, 31,714 t. Streets are ~12 m, so a toppling tower reaches its
# neighbours -- unlike fractured-district.json, which spaces buildings by what
# they can reach when they fall and therefore cannot be knocked over into
# itself. That spacing exists for a reason (PhysX sleeps per contact island, and
# merged rubble fields settle as one), so the district remains the safer pack;
# this one trades that for a city you can actually collapse onto itself.
# fractured-highrise-10f.json is the same format at 1/22 the size and is the
# fast choice for iterating on stress behaviour.
export VIBE_CITY_SCENE="${VIBE_CITY_SCENE:-fractured-downtown.json}"
# Full authored strength. The old 0.10 made buildings ~10x weaker than the
# geometry was drawn for, to compensate for shots that could not fracture
# anything on their own -- and at that scale the structure cannot even hold
# itself up: measured 7,052 bonds broken with zero shots fired, self-weight two
# orders of magnitude past the elastic limit. Note this dial multiplies elastic
# AND fatal together, so it moves strength only; ductility lives in the pack's
# per-material band and cannot be reached from here.
export VIBE_CITY_STRESS_LIMIT_SCALE="${VIBE_CITY_STRESS_LIMIT_SCALE:-1.0}"
# Grid edge in buildings; pitch comes from the pack footprint, so this widens
# the map without crowding it. The district pack is already a laid-out block of
# mixed buildings spanning 289x273 m, so it wants a grid of 1 -- raising this
# tiles whole districts and multiplies 15,918 chunks by grid^2.
export VIBE_CITY_GRID="${VIBE_CITY_GRID:-1}"
# Structural packs author a load path through frame, slabs and facade. Floor
# truncation slices at a Y cutoff and can leave panels hanging off a removed
# slab, so varied heights stay off unless asked for.
export VIBE_CITY_VARIED_HEIGHTS="${VIBE_CITY_VARIED_HEIGHTS:-0}"
export RUST_LOG="${RUST_LOG:-info}"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"

: > "$LOG"
( "$BIN" >> "$LOG" 2>&1; echo "EXIT_STATUS=$?" >> "$LOG" ) &

for _ in $(seq 1 40); do
  sleep 0.5
  if grep -q 'starting web fps server' "$LOG" 2>/dev/null; then
    echo "started ($PROFILE, pid $(pgrep -x web-fps-server | tr '\n' ' ')) -- world reset, log: $LOG"
    exit 0
  fi
  if ! pgrep -x web-fps-server >/dev/null; then
    echo "server exited during startup:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
done

echo "server did not report readiness within 20s; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
