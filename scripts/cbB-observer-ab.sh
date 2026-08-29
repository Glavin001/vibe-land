#!/usr/bin/env bash
# Lever B verdict: observer-tail deferral, measured through the REAL server
# loop with a REAL client attached.
#
#   obsoff : VIBE_CITY_OBSERVER_PIPELINE=0  (combined step, observer tail after)
#   obson  : VIBE_CITY_OBSERVER_PIPELINE=1  (split step, tick N-1's tail inside
#                                            tick N's GPU wait)
#
# Why a browser client rather than record-city-trace: the trace harness runs
# its own loop, not main.rs's, so it cannot execute this code path at all —
# and with zero players the observer tail is free, because there is nobody to
# encode for. The client costs CPU (swiftshader), but identically in both
# arms, and arms are what we compare.
#
# One binary, env-switched, alternating arm order.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

stop_server() {
  for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done
}

start_server() {  # $1 = observer pipeline flag
  VIBE_CITY_OBSERVER_PIPELINE="$1" nohup setsid bash scripts/run-vl4-server.sh \
    >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    curl -sk https://127.0.0.1:8384/healthz >/dev/null 2>&1 && return 0
    sleep 1
  done
  log "server did not come up with OBSERVER_PIPELINE=$1"
  return 1
}

run_arm() {  # $1 = label, $2 = flag, $3 = repeat
  local label=$1 flag=$2 repeat=$3
  log "$label run $repeat (OBSERVER_PIPELINE=$flag)"
  date -u +%s > "/tmp/obs-$label-$repeat.start" 
  stop_server
  start_server "$flag" || return 1
  # A fresh city per arm: a match that carries a previous run's rubble is a
  # different scene, which is the confound that has already invalidated one
  # A/B on this tree.
  ( cd client && \
    E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 \
    E2E_BASE_URL=https://127.0.0.1:8384 \
    E2E_CITY_URL_PARAMS='portal=true&match=city-default' \
    E2E_CITY_WT_URL=https://127.0.0.1:4435/game \
    OBS_SAMPLE_OUT="/tmp/obs-$label-$repeat.jsonl" \
    OBS_SHOTS=25 OBS_TARGETS=8 \
    npx playwright test --config e2e/playwright.config.ts city-observer-pipeline-load \
    > "/tmp/obs-$label-$repeat.log" 2>&1 ) || log "$label $repeat driver FAILED (see /tmp/obs-$label-$repeat.log)"
  date -u +%s > "/tmp/obs-$label-$repeat.end"
  wc -l < "/tmp/obs-$label-$repeat.jsonl" 2>/dev/null | xargs -I{} log "$label $repeat samples: {}"
}

for repeat in a b; do
  run_arm obsoff 0 "$repeat"
  run_arm obson 1 "$repeat"
done

log "restoring production server (pipeline off until the verdict says otherwise)"
stop_server
start_server 0
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "OBSERVER A/B DONE"
