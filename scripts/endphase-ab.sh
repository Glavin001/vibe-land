#!/usr/bin/env bash
# E1-E7 verdict battery: one binary, env-switched arms, alternating order.
#
#   endoff : every E-fix disabled (the pre-E behaviour)
#   endon  : defaults (all fixes on)
#
# The fracture-heavy recipe, because `end` only costs when things break.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

while true; do
  players=$(curl -sk https://127.0.0.1:8384/healthz \
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
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
  VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 VIBE_PHYSX_PROFILE_FETCH=1

run() {  # $1 = label, $2 = "off"|"on"
  log "$1 ($2)"
  local envs=()
  if [ "$2" = "off" ]; then
    envs=(BLAST_FRACTURE_NODE_SKIP=0 BLAST_APPLY_INDEX_INCREMENTAL=0
          BLAST_VALIDATE_INTERVAL=1 BLAST_SINGLE_NODE_CENSUS_INTERVAL=1)
    # NOT disabled in the off arm: FRACTURE_REUSE_BUFFERS / INCREMENTAL_LOOKUP
    # (pre-existing defaults on both arms) — the arms differ ONLY by this
    # session's fixes.
  fi
  env "${envs[@]}" ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 240 --shots 100 --shot-interval-ticks 20 --targets 4 --aim-lock \
    --output /dev/null --label "$1" --packets-wire 3 > "/tmp/$1.log" 2>&1 || log "$1 FAILED"
}
for repeat in a b; do
  run endoff off
  run endon on
done

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "ENDPHASE A/B DONE"
