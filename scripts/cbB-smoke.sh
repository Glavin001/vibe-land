#!/usr/bin/env bash
# Bring the server up with the observer pipeline ON and prove it functions
# (join, bombard, ledger agrees) before spending a battery on measuring it.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

VIBE_CITY_OBSERVER_PIPELINE=1 nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
for _ in $(seq 1 30); do
  curl -sk https://127.0.0.1:8384/healthz >/dev/null 2>&1 && break
  sleep 1
done
srv=$(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1; exit}')
log "server pid=$srv inode=$(stat -L -c %i /proc/$srv/exe 2>/dev/null)"
tr '\0' '\n' < "/proc/$srv/environ" | grep OBSERVER || log "OBSERVER flag NOT in env"

cd client
E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 \
E2E_BASE_URL=https://127.0.0.1:8384 \
E2E_CITY_URL_PARAMS='portal=true&match=city-default' \
E2E_CITY_WT_URL=https://127.0.0.1:4435/game \
OBS_SAMPLE_OUT=/tmp/obs-smoke.jsonl OBS_SHOTS=8 OBS_TARGETS=2 \
  npx playwright test --config e2e/playwright.config.ts city-observer-pipeline-load \
  2>&1 | tail -25
log "SMOKE DONE"
