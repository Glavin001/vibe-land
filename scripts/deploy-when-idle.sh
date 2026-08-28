#!/usr/bin/env bash
# Deploy, but only once the match is empty.
#
# cbA-deploy.sh restarts immediately, and doing that mid-session dropped the
# owner out of a live game. A deploy is not urgent; a player is.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for _ in $(seq 1 120); do
  # A DOWN server is not a busy one. The first version defaulted to 1 on any
  # curl/parse failure, so when a gate script left the server stopped, this
  # watcher waited forever for a phantom player to leave.
  if ! curl -sk --max-time 5 https://127.0.0.1:8384/healthz > /tmp/deploy-health.json 2>/dev/null; then
    log "server not responding; treating as free to deploy"
    break
  fi
  players=$(python3 -c 'import json; print(json.load(open("/tmp/deploy-health.json"))["players"])' 2>/dev/null || echo unknown)
  if [ "$players" = "0" ] || [ "$players" = "unknown" ]; then
    break
  fi
  log "players=$players connected; holding the deploy"
  sleep 30
done
if curl -sk --max-time 5 https://127.0.0.1:8384/healthz > /tmp/deploy-health.json 2>/dev/null; then
  players=$(python3 -c 'import json; print(json.load(open("/tmp/deploy-health.json"))["players"])' 2>/dev/null || echo 0)
  if [ "$players" != "0" ]; then
    log "still occupied after an hour; NOT deploying"
    exit 1
  fi
fi
log "match empty; deploying"
bash scripts/cbA-deploy.sh
