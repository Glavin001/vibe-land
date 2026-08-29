#!/usr/bin/env bash
# Gate battery + deploy for the per-tick contact-wake judgement (d8f7976).
# MUST live in a file: an inline bash -c version of this killed itself — its
# own command line matched the supervisor kill pattern.
#
# On green: deploy the freshly built binary. On red: restore the binary that
# was serving when the battery started, so a red gate can never ship.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  sleep 60
done
log "player-free; snapshotting serving binary and stopping server"
srv_pid=$(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1; exit}')
if [ -n "$srv_pid" ]; then
  cp "/proc/$srv_pid/exe" /tmp/web-fps-server-prev
else
  cp target/release/web-fps-server-vl4 /tmp/web-fps-server-prev
fi
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
log "gate 1: scenario suite"
bash scripts/scenario-suite.sh > /tmp/wake-fix-suite.log 2>&1
SUITE=$?
log "suite exit $SUITE; gate 2: floater repro"
env BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
    VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
    VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
    VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
    VIBE_CITY_POSE_CENSUS=1 \
  ./target/release/record-city-trace --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 1 --seconds 110 --shots 30 --shot-interval-ticks 40 --targets 1 --aim-lock \
    --output /dev/null --packets-out /tmp/wake-fix-floater --packets-wire 3 \
    > /tmp/wake-fix-floater.log 2>&1
TAIL=$(python3 -c "
import json
rows=[json.loads(l) for l in open('/tmp/wake-fix-floater/timings.jsonl')]
print(max(r.get('floating',0) for r in rows[-300:]))" 2>/dev/null || echo 99)
log "SUITE=$SUITE FLOATER_TAIL=$TAIL (ceiling 5; prior builds measured 2-4)"
if [ "$SUITE" = "0" ] && [ "$TAIL" -le 5 ]; then
  ln -f target/release/web-fps-server target/release/web-fps-server-vl4
  log "GREEN — deploying wake-fix build"
else
  cp /tmp/web-fps-server-prev target/release/web-fps-server-vl4
  log "RED — restored the previously serving binary; wake fix NOT deployed"
fi
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "server restarted"
