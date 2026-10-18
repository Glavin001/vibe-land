#!/usr/bin/env bash
# The decisive flip: vibe-land-4 held at d8f7976 (green 05:56, red 19:07),
# blast rolled back to pre-A2 (3bac178e^). Green here convicts the blast A2
# commit; red convicts the box. Runs the pre-A2 arm TWICE for n=2.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1
export VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_FREEZE=1 VIBE_CITY_RESIM_PASSES=0
export VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7
export VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_CITY_STRESS_LIMIT_SCALE=0.45
export VIBE_CITY_VARIED_HEIGHTS=0 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02

git checkout -q d8f7976
git -C /root/workspace/blast-stress-solver-2 checkout -q 3bac178e^ || { log "blast checkout failed"; exit 1; }
log "blast now at: $(git -C /root/workspace/blast-stress-solver-2 log --oneline -1)"
# build.rs must see the blast sources changed; touch to defeat any staleness.
cargo build --release -p web-fps-server --features cuda-stress --bin record-city-trace > /tmp/blast-flip-build.log 2>&1 \
  || { log "build failed"; git checkout -q perf/rubble-field-60hz; git -C /root/workspace/blast-stress-solver-2 checkout -q perf/rubble-field-60hz; exit 1; }
for repeat in a b; do
  log "=== d8f7976 + blast pre-A2, run $repeat ==="
  bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed "s/^/[preA2-$repeat] /"
done

git checkout -q perf/rubble-field-60hz
git -C /root/workspace/blast-stress-solver-2 checkout -q perf/rubble-field-60hz
log "restored: vl4=$(git log --oneline -1 | cut -c1-40) blast=$(git -C /root/workspace/blast-stress-solver-2 log --oneline -1 | cut -c1-40)"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "FLIP TEST DONE"
