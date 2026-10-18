#!/usr/bin/env bash
# Supervisor for THIS checkout's city server (vibe-land, feat/city-concrete-and-lighting).
#
# Deliberately NOT scripts/run-city-server.sh: that script's stop_server does
# `pgrep -x web-fps-server`, which matches the sibling checkouts' servers too --
# vibe-land-2's QA server on 4003 is live, and killing it would take down
# someone else's port-40610 preview. The binary is hardlinked to a distinct
# name (web-fps-server-vl1) so process-name matching can never cross checkouts.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$REPO_ROOT/target/release/web-fps-server-vl1"
LOG="${VIBE_CITY_LOG:-/tmp/vl1-city-server.log}"

export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${LD_LIBRARY_PATH:+:}/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release"
export VIBE_PHYSICS_BACKEND=physx_gpu
export WT_STRICT_SNAPSHOT_DATAGRAMS=1
export BIND_ADDR=127.0.0.1:4009
export WT_BIND_ADDR=0.0.0.0:4436
export WT_PUBLIC_URL=https://209.121.195.117:40666
export WT_CERT_PEM="$REPO_ROOT/.certs/page-cert.pem"
export WT_KEY_PEM="$REPO_ROOT/.certs/page-key.pem"
export VIBE_CITY_SCENE="${VIBE_CITY_SCENE:-fractured-downtown.json}"
export VIBE_CITY_STRESS_LIMIT_SCALE=1.0
export VIBE_CITY_GRID=1
export VIBE_CITY_VARIED_HEIGHTS=0
export VIBE_CITY_FREEZE=0
export SKIP_SPACETIMEDB_VERIFY=1
export RUST_LOG="${RUST_LOG:-info}"
export VIBE_CITY_TELEMETRY=/tmp/vl1-city-telemetry.jsonl
export RUST_BACKTRACE=full

while true; do
  ( "$BIN" >> "$LOG" 2>&1; echo "EXIT_STATUS=$?" >> "$LOG" )
  sleep 3
done
