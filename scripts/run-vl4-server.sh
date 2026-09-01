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
#
# THE HARDLINK MUST BE REFRESHED ON EVERY LAUNCH. `cargo build` writes a NEW
# inode at web-fps-server and leaves web-fps-server-vl4 pointing at the old
# one, so this script will happily serve a binary from hours earlier. That is
# not hypothetical: on 2026-08-31 a restart served a 03:40 build while a 19:49
# build sat unused, and the debug reports that came back showed solve_ms 9.3 ms
# against the correct build's 4.1 ms at matched damage. It read as a 2.3x
# performance regression and was entirely a stale deploy. The relink below,
# and the banner it prints, are what make that impossible to miss.
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

SRC=target/release/web-fps-server
DST=target/release/web-fps-server-vl4
if [ ! -f "$SRC" ]; then
  echo "REFUSING: $SRC does not exist. Build first:"
  echo "  cargo build --release -p web-fps-server --features cuda-stress,blast-core"
  exit 1
fi
if [ ! -f "$DST" ] || [ "$(stat -c %i "$SRC")" != "$(stat -c %i "$DST")" ]; then
  echo "[deploy] relinking $DST -> current build ($(stat -c %y "$SRC" | cut -c1-19))"
  ln -f "$SRC" "$DST" || { echo "REFUSING: could not relink"; exit 1; }
fi
# The CPU solver's iteration residual reads as real stress and breaks bonds
# that are not overloaded, so a binary without the GPU solver silently
# simulates a different game. Refuse rather than serve it.
if ! strings "$DST" | grep -q ExtStressGpuSolver; then
  echo "REFUSING: $DST has no CUDA stress solver (built without --features"
  echo "  cuda-stress). The CPU fallback breaks bonds that are not overloaded."
  exit 1
fi
echo "[deploy] launching $(stat -c '%y inode=%i' "$DST" | cut -c1-19,20-)"

while true; do
  ./target/release/web-fps-server-vl4 >> /tmp/srv4005.log 2>&1
  echo "[supervisor] server exited code=$? at $(date -u +%H:%M:%S); restarting in 3s" >> /tmp/srv4005.log
  sleep 3
done
