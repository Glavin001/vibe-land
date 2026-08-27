#!/usr/bin/env bash
# The same sources that were green at 05:56 are red now (n=2), so the box —
# not the code — changed. This probe splits the GPU stack:
#   arm cpu-stress : CUDA stress solver OFF (CPU CG). Green-ish (<~hundreds)
#                    convicts the CUDA stress solve; red convicts PhysX GPU
#                    dynamics (or both).
#   arm jit-clear  : GPU stress back ON after clearing the CUDA JIT cache.
# Uses current HEAD binary (already built). Server down throughout.
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

log "=== arm cpu-stress (VIBE_CITY_GPU_STRESS=0) ==="
VIBE_CITY_GPU_STRESS=0 bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed 's/^/[cpu-stress] /'

log "=== arm jit-clear (GPU stress on, ComputeCache cleared) ==="
du -sh ~/.nv/ComputeCache 2>/dev/null || echo "no ComputeCache dir"
rm -rf ~/.nv/ComputeCache
bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed 's/^/[jit-clear] /'

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "GPU STATE PROBE DONE"
