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

# --- remote mode --------------------------------------------------------------
# Set VIBE_PUBLIC_IP (and VIBE_UDP_PORT, the EXTERNAL one) to run this on a
# rented box instead of a laptop. Everything below it is derived.
#
# This exists because the defaults further down are a laptop's, and every one of
# them is wrong on a remote host in a way that fails late and confusingly:
#
#   WT_PUBLIC_URL  hardcodes a home IP -- clients dial someone else's router
#   WT_BIND_ADDR   binds 4434, while every image here maps container 4433
#   BIND_ADDR      binds 127.0.0.1 -- unreachable from outside the box
#   WEB_BIND_ADDR  unset, so the HTTPS listener never starts and /city cannot
#                  be served at all (WebTransport refuses an insecure context)
#   VIBE_WEB_DIR   defaults to /opt/vibe-land/web, which exists only inside the
#                  runtime image; on a dev box the listener silently degrades
#                  to api-only and every page 404s
#
# Reconstructing those by hand took four round trips on the first real dev box.
#
#   VIBE_PUBLIC_IP=203.0.113.9 VIBE_UDP_PORT=51745 scripts/run-city-server.sh
#
# The ports on the left are the container-side ones the images map; the external
# ports Vast assigns differ per instance and only WT_PUBLIC_URL needs one.
if [[ -n "${VIBE_PUBLIC_IP:-}" ]]; then
  if [[ -z "${VIBE_UDP_PORT:-}" ]]; then
    echo "VIBE_PUBLIC_IP is set but VIBE_UDP_PORT is not." >&2
    echo "VIBE_UDP_PORT is the EXTERNAL udp port mapped to container 4433:" >&2
    echo "  vastai show instance <id> --raw | jq '.ports[\"4433/udp\"][0].HostPort'" >&2
    exit 2
  fi
  export BIND_ADDR="${BIND_ADDR:-0.0.0.0:4001}"
  export WEB_BIND_ADDR="${WEB_BIND_ADDR:-0.0.0.0:4443}"
  export WT_BIND_ADDR="${WT_BIND_ADDR:-0.0.0.0:4433}"
  export WT_PUBLIC_URL="${WT_PUBLIC_URL:-https://${VIBE_PUBLIC_IP}:${VIBE_UDP_PORT}}"
  export VIBE_WEB_DIR="${VIBE_WEB_DIR:-$REPO_ROOT/client/dist}"

  # Mint the certificate if it is not already there. ECDSA P-256, 12 days, with
  # the IP as a SAN -- the exact shape `serverCertificateHashes` requires.
  # Browsers reject RSA there and reject anything valid beyond 14 days. This
  # mirrors docker/entrypoint.sh, which does the same for the runtime image.
  cert="${WT_CERT_PEM:-$REPO_ROOT/.certs/page-cert.pem}"
  key="${WT_KEY_PEM:-$REPO_ROOT/.certs/page-key.pem}"
  if [[ ! -s "$cert" || ! -s "$key" ]]; then
    echo "minting a self-signed P-256 certificate for IP:${VIBE_PUBLIC_IP} (12 days)"
    mkdir -p "$(dirname "$cert")" "$(dirname "$key")"
    openssl ecparam -name prime256v1 -genkey -noout -out "$key"
    openssl req -new -x509 -key "$key" -out "$cert" \
      -days 12 -subj "/CN=${VIBE_PUBLIC_IP}" \
      -addext "subjectAltName=IP:${VIBE_PUBLIC_IP}"
  fi
  export WT_CERT_PEM="$cert"
  export WT_KEY_PEM="$key"

  if [[ ! -f "$VIBE_WEB_DIR/index.html" ]]; then
    echo "WARNING: no client bundle at $VIBE_WEB_DIR -- /city will 404." >&2
    echo "         build it with: (cd $REPO_ROOT/client && npm ci && npm run build)" >&2
  fi

  echo "remote mode: open https://${VIBE_PUBLIC_IP}:<external port for 4443>/city"
fi

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
# Server-side telemetry: every ~1s stats snapshot appended as JSONL, so any
# session is analyzable after the fact (bodies vs tick cost, governor state,
# encoder spikes). One file per world lifetime -- restart truncates it.
export VIBE_CITY_TELEMETRY="${VIBE_CITY_TELEMETRY:-/tmp/city-telemetry.jsonl}"
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
