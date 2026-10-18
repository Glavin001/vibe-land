#!/usr/bin/env bash
# Rebuild with cuda-stress (the feature my earlier `--features destruction`
# builds silently dropped, which is what made every at-rest arm today read
# ~30k bonds) and re-verify the gate on HEAD (A0+A1+A2).
#
# `--features destruction` builds a CPU-solver binary. server/Cargo.toml says
# so in a comment; the perf skill records the same symptom (spontaneous
# at-rest breaks 40 -> 0 with cuda-stress). Every build command in this repo
# that produces a MEASUREMENT binary must use --features cuda-stress.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
log "building HEAD with cuda-stress: $(git log --oneline -1)"
cargo build --release -p web-fps-server --features cuda-stress > /tmp/cbA-rebuild.log 2>&1 || {
  log "BUILD FAILED"; tail -20 /tmp/cbA-rebuild.log; exit 1; }
log "build ok"

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

export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1
export VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_FREEZE=1 VIBE_CITY_RESIM_PASSES=0
export VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7
export VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_CITY_STRESS_LIMIT_SCALE=0.45
export VIBE_CITY_VARIED_HEIGHTS=0 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02

log "=== at-rest on the correctly-built HEAD ==="
bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed 's/^/[head-cuda] /'
AT_REST=${PIPESTATUS[0]}

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "REBUILD+VERIFY DONE (at_rest=$AT_REST)"
