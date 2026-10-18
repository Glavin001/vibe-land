#!/usr/bin/env bash
# Bisect the T1 at-rest regression (27,959 bonds at rest on 500c5b2/A2).
# Runs check-at-rest at A1 (d3d5b25), A0 (24c65e8), and baseline (6bd8c24),
# rebuilding record-city-trace at each. Server must stay down throughout;
# restarts it and returns to the branch when done.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1

for commit in d3d5b25 24c65e8 6bd8c24; do
  log "=== $commit ==="
  git checkout -q "$commit" || { log "checkout $commit failed"; break; }
  cargo build --release -p web-fps-server --features cuda-stress --bin record-city-trace > /tmp/bisect-build-$commit.log 2>&1 \
    || { log "build $commit failed"; continue; }
  bash scripts/check-at-rest.sh 0.45 90 2>&1 | sed "s/^/[$commit] /"
done

git checkout -q perf/rubble-field-60hz
log "back on branch: $(git log --oneline -1)"
nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "BISECT DONE"
