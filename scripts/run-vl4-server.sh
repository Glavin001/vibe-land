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

export VIBE_PHYSICS_BACKEND=physx_gpu
export VIBE_CITY_SCENE=fractured-downtown.json
export VIBE_CITY_GRID=${VIBE_CITY_GRID:-2}
export VIBE_CITY_VARIED_HEIGHTS=0
export VIBE_CITY_FREEZE=1
export VIBE_CITY_STRESS_LIMIT_SCALE=0.45
export VIBE_CITY_SHOT_BLAST_RADIUS=0.7
export VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7
export VIBE_CITY_EXCESS_FORCES=1
export VIBE_CITY_RESIM_PASSES=0
export VIBE_CITY_SOLVER_ITERATIONS=32
export VIBE_WORLD_FRICTION=0.75
export VIBE_WORLD_RESTITUTION=0.02
# VIBE_PHYSX_PROFILE_FETCH deliberately NOT set: the fetch-split busy-poll
# was measured at +0.91 ms/tick (n=2/arm, equivalence-guarded verdict, the
# +0.85 attributed to the physx bracket where the spin lives). Production
# gives up the live gpu_wait/fetch_copy split; traces keep the flag on.
# DEFAULT ON: the incremental device-topology change (blast 5ed909d9) makes
# the GRID=2 city tear itself apart at rest -- no players, no shots, 0 ->
# 122,819 broken bonds in 90 s, bond utilisation 4,349-14,350x, step 22 -> 132
# ms. With this switch the same scene holds at 0 broken, 0 awake, utilisation
# 1.0, 3.7 ms. Set to 0 only to reproduce the bug.
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=${BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY:-1}
export RUST_LOG=info

cd "$ROOT"
while true; do
  ./target/release/web-fps-server-vl4 >> /tmp/srv4005.log 2>&1
  echo "[supervisor] server exited code=$? at $(date -u +%H:%M:%S); restarting in 3s" >> /tmp/srv4005.log
  sleep 3
done
