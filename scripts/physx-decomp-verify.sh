#!/usr/bin/env bash
# Verify the rigid-body decomposition before deploying it:
#   1. the at-rest gate still passes (instrumentation must not move physics)
#   2. the new spans are populated and internally consistent
#   3. the sampled poll's overhead is priced (SAMPLE_TICKS=0 vs 16), because
#      an instrument nobody priced is how PROFILE_FETCH cost 0.91 ms/tick
#      unnoticed for weeks.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
  VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
  VIBE_CITY_POSE_CENSUS=1

log "gate: at-rest (instrumentation must not move physics)"
bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed 's/^/[at-rest] /'

# PROFILE_FETCH deliberately OFF: the point is that the new sampled path
# gives the split WITHOUT the every-tick poll.
run() {  # $1 = label, $2 = sample interval
  log "$1 run (SAMPLE_TICKS=$2)"
  VIBE_PHYSX_GPU_SAMPLE_TICKS=$2 ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 200 --shots 40 --shot-interval-ticks 40 --targets 2 \
    --aim-lock --output /dev/null --label "$1" --packets-wire 3 \
    > "/tmp/$1.log" 2>&1 || log "$1 FAILED"
}
for repeat in a b; do
  run decompoff 0
  run decompon 16
done

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "DECOMP VERIFY DONE"
