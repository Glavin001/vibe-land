#!/usr/bin/env bash
# The vibe-land-4 live server, exactly as deployed behind Caddy 8384 -> public
# https://209.121.195.117:40617/city (WebTransport UDP 4435 -> public 40628).
#
# Run this script; do not hand-assemble the env. It exists because a restart
# that reconstructed the env from a partial grep of /proc/<pid>/environ lost
# BIND_ADDR/WT_* and came up on the wrong ports.
#
# The binary is hardlinked as web-fps-server-vl4 so vibe-land-2's
# run-city-server.sh (`pkill -x web-fps-server`) cannot kill it.
set -uo pipefail
ROOT=/root/workspace/vibe-land-4
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}${LD_LIBRARY_PATH:+:}/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release"

export BIND_ADDR=127.0.0.1:4005
export WT_BIND_ADDR=0.0.0.0:4435
export WT_PUBLIC_URL=https://209.121.195.117:40628
export WT_CERT_PEM=$ROOT/.certs/page-cert.pem
export WT_KEY_PEM=$ROOT/.certs/page-key.pem
export WT_STRICT_SNAPSHOT_DATAGRAMS=1

# Physics/destruction knobs are shared with the perf suite; see the file.
. "$ROOT/scripts/physics-env.sh"

export RUST_LOG=info

cd "$ROOT"
while true; do
  ./target/release/web-fps-server-vl4 >> /tmp/srv4005.log 2>&1
  echo "[supervisor] server exited code=$? at $(date -u +%H:%M:%S); restarting in 3s" >> /tmp/srv4005.log
  sleep 3
done
