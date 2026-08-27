#!/usr/bin/env bash
# Lever A (A1+A2) gate battery + measurement runs. Build BEFORE invoking;
# this script never compiles the trace binary (mid-experiment rebuilds have
# polluted an experiment already — run names embed git and would diverge).
#
# Gates: unit/behavior tests incl. the CSE-off arm, scenario suite, then two
# cbA12 baseline-recipe runs. Verdict + deploy decisions happen OUTSIDE this
# script, after reading the artifacts. Server is stopped for GPU exclusivity
# and restarted (still on its previous binary — this script does not deploy).
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  sleep 60
done
log "player-free; stopping server"
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"

log "gate 1: freeze_wake_semantics (CSE on)"
cargo test -q -p physx-bridge --release --features cuda-stress --test freeze_wake_semantics > /tmp/cbA-fw-on.log 2>&1
FW_ON=$?
log "gate 2: freeze_wake_semantics (CSE off)"
VIBE_PHYSX_CONTACT_CSE=0 cargo test -q -p physx-bridge --release --features cuda-stress --test freeze_wake_semantics > /tmp/cbA-fw-off.log 2>&1
FW_OFF=$?
log "gate 3: destruction_smoke"
cargo test -q -p physx-bridge --release --features cuda-stress --test destruction_smoke > /tmp/cbA-smoke.log 2>&1
SMOKE=$?
log "gate 4: timing_consistency"
cargo test -q -p physx-bridge --release --features cuda-stress --test timing_consistency > /tmp/cbA-timing.log 2>&1
TIMING=$?
log "gate 5: scenario suite"
bash scripts/scenario-suite.sh > /tmp/cbA-suite.log 2>&1
SUITE=$?
log "gates: fw_on=$FW_ON fw_off=$FW_OFF smoke=$SMOKE timing=$TIMING suite=$SUITE"

export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
  VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
  VIBE_PHYSX_PROFILE_FETCH=1 VIBE_CITY_POSE_CENSUS=1
for repeat in a b; do
  log "cbA12 run $repeat"
  ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 200 --shots 40 --shot-interval-ticks 40 --targets 2 \
    --aim-lock --output /dev/null --label cbA12 --packets-wire 3 \
    > "/tmp/cbA12-$repeat.log" 2>&1 || log "cbA12 $repeat FAILED"
done

log "restarting server (previous binary, no deploy here)"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "cbA GATE+MEASURE DONE: fw_on=$FW_ON fw_off=$FW_OFF smoke=$SMOKE timing=$TIMING suite=$SUITE"
