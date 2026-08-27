#!/usr/bin/env bash
# Deploy, but only once the match is empty.
#
# cbA-deploy.sh restarts immediately, and doing that mid-session dropped the
# owner out of a live game. A deploy is not urgent; a player is.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for _ in $(seq 1 120); do
  players=$(curl -sk https://127.0.0.1:8384/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  log "players=$players connected; holding the deploy"
  sleep 30
done
players=$(curl -sk https://127.0.0.1:8384/healthz \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
if [ "$players" != "0" ]; then
  log "still occupied after an hour; NOT deploying"
  exit 1
fi
log "match empty; deploying"
bash scripts/cbA-deploy.sh
