#!/usr/bin/env bash
# At-rest bisect, take 2 — under the FULL suite env this time. Take 1 used
# check-at-rest's reduced env (no EXCESS_FORCES etc.), which was never green
# anywhere, so its all-red result bounds nothing. d8f7976 (wake-fix) ran
# green under the suite env at 05:56 and anchors the window.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
# The suite env, verbatim from its banner (T1-relevant superset).
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1
export VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_FREEZE=1 VIBE_CITY_RESIM_PASSES=0
export VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7
export VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_CITY_STRESS_LIMIT_SCALE=0.45
export VIBE_CITY_VARIED_HEIGHTS=0 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02

for commit in "$@"; do
  log "=== $commit ==="
  git checkout -q "$commit" || { log "checkout $commit failed"; break; }
  cargo build --release -p web-fps-server --features cuda-stress --bin record-city-trace > /tmp/bisect2-build-$commit.log 2>&1 \
    || { log "build $commit failed"; continue; }
  bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed "s/^/[$commit] /"
done

git checkout -q perf/rubble-field-60hz
log "back on branch: $(git log --oneline -1)"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "BISECT2 DONE"
