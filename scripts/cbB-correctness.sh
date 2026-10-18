#!/usr/bin/env bash
# Does the observer pipeline change what the SIMULATION does?
#
# My own load driver reported 2/2 destruction failures with the pipeline on
# against 0/2 with it off, which is either a real defect or a chaotic driver
# (its walk phase took different paths in the two arms). This runs the repo's
# existing, deterministic destruction gate against both arms instead: it
# encodes what correct destruction looks like and does not depend on my
# driver's pathing.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

stop_server() {
  for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done
}

start_server() {
  VIBE_CITY_OBSERVER_PIPELINE="$1" nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    curl -sk https://127.0.0.1:8384/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

run_spec() {  # $1 = flag, $2 = spec
  stop_server
  start_server "$1" || { log "server failed to start (flag=$1)"; return 1; }
  log "=== $2 with OBSERVER_PIPELINE=$1 ==="
  ( cd client && \
    E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 \
    E2E_BASE_URL=https://127.0.0.1:8384 \
    E2E_CITY_URL_PARAMS='portal=true&match=city-default' \
    E2E_CITY_WT_URL=https://127.0.0.1:4435/game \
    npx playwright test --config e2e/playwright.config.ts "$2" \
    > "/tmp/cbB-$2-$1.log" 2>&1 )
  local rc=$?
  log "$2 flag=$1 exit=$rc"
  grep -E "passed|failed|✓|✘" "/tmp/cbB-$2-$1.log" | tail -6
}

run_spec 0 city-destruction
run_spec 1 city-destruction
run_spec 0 city-stream-agreement
run_spec 1 city-stream-agreement

log "restoring production server, pipeline off"
stop_server
start_server 0
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "CORRECTNESS DONE"
