#!/usr/bin/env bash
# A0: one baseline-recipe run on the sub-instrumented build (label cbA0) to
# decompose contact_callback_est_ms into extract/queue/pair_load/wake before
# any optimization is written. File script, kill by PID lists — inline
# wrappers have self-matched their own command lines three times already.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  sleep 60
done
log "player-free; stopping server for GPU-exclusive trace"
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
  VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
  VIBE_PHYSX_PROFILE_FETCH=1 VIBE_CITY_POSE_CENSUS=1
./target/release/record-city-trace \
  --scene destruction/assets/scenes/fractured-downtown.json \
  --grid 2 --seconds 200 --shots 40 --shot-interval-ticks 40 --targets 2 \
  --aim-lock --output /dev/null --label cbA0 --packets-wire 3 \
  > /tmp/cbA0.log 2>&1
TRACE=$?
log "trace exit $TRACE; restarting server"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "cbA0 DONE"
