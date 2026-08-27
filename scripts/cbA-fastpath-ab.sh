#!/usr/bin/env bash
# Lever A verdict: ONE binary, two arms, alternating order.
#
#   fpoff : VIBE_PHYSX_CONTACT_FASTPATH=0  (original per-side/per-point lookups)
#   fpon  : VIBE_PHYSX_CONTACT_FASTPATH=1  (A1 + A2)
#
# Alternating a/b ordering so any thermal or cache drift across the battery
# splits evenly between arms instead of loading one of them.
#
# The recipe is deliberately heavier than the standard baseline: 100 shots at
# 20-tick spacing on 4 targets, because the standard plan tops out at ~8k
# callbacks/tick while the live cascades that motivated this lever run
# 13-15k. An optimization must be measured in the regime it is for.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  log "players connected; waiting"
  sleep 60
done
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

run_arm() {
  local label=$1 fastpath=$2 repeat=$3
  log "$label run $repeat (FASTPATH=$fastpath)"
  VIBE_PHYSX_CONTACT_FASTPATH=$fastpath ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 240 --shots 100 --shot-interval-ticks 20 --targets 4 \
    --aim-lock --output /dev/null --label "$label" --packets-wire 3 \
    > "/tmp/$label-$repeat.log" 2>&1 || log "$label $repeat FAILED"
}

for repeat in a b; do
  run_arm cbfpoff 0 "$repeat"
  run_arm cbfpon 1 "$repeat"
done

log "restarting server"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "FASTPATH A/B DONE"
