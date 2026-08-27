#!/usr/bin/env bash
# P1b gate battery + deploy, run when the live server is player-free.
#
# Order matters: everything gates BEFORE the deploy, and the deploy only
# happens on a fully green battery. Logs under /tmp/p1b-gates/.
#
#   1. scenario suite (env-pinned since aaa6888) with aggregates ON
#   2. floater repro: 0 frozen-phase floaters, wake behaviour intact
#   3. collapse-onto-frozen-field A/B: aggregates ON vs OFF, the broken-bond
#      totals must land inside the same band (aggregation must not change
#      contact results; exact sequence identity is not expected — GPU damage
#      varies run to run, which is why this is a band, not an equality)
#   4. matched-load perf number for the commit record
#   5. hardlink refresh + restart via run-vl4-server.sh, healthz verify
set -uo pipefail
cd /root/workspace/vibe-land-4
out=/tmp/p1b-gates
mkdir -p "$out"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$out/pipeline.log"; }

# ---- wait for player-free ------------------------------------------------
while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  sleep 60
done
log "server player-free; starting P1b gate battery"

# ---- stop the live server: every supervisor-shaped pid, then the server,
# then WAIT until it is actually gone. The first version killed only the
# first match, which was the bash -c wrapper — the real supervisor lived on
# and respawned the server before the suite started, and the suite's own
# refusal guard (correctly) aborted the run.
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do
  kill "$pid" 2>/dev/null || true
done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 1 30); do
  ps -eo args | grep -q "[w]eb-fps-server-vl4" || break
  sleep 1
done
ps -eo args | grep -q "[w]eb-fps-server-vl4" && { log "server refused to die"; exit 1; }
log "live server stopped and confirmed gone"

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1

fail() { log "FAILED: $1 — deploy ABORTED, restarting server on the previous binary"; restart; exit 1; }

restart() {
  nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
  sleep 8
  curl -sk https://127.0.0.1:8384/healthz | head -c 80 >> "$out/pipeline.log"
  log "server restarted"
}

# ---- gate 1: scenario suite (aggregates ON by default) -------------------
log "gate 1: scenario suite"
bash scripts/scenario-suite.sh > "$out/suite.log" 2>&1
[ $? -eq 0 ] || fail "scenario suite (see $out/suite.log)"
log "gate 1 green"

# ---- gate 2: floater repro ----------------------------------------------
log "gate 2: floater repro"
env VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32 \
    VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 VIBE_CITY_STRESS_LIMIT_SCALE=0.45 \
    VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 \
    VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
    VIBE_CITY_POSE_CENSUS=1 VIBE_CITY_POSE_CENSUS_DUMP=1 \
  ./target/release/record-city-trace --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 1 --seconds 110 --shots 30 --shot-interval-ticks 40 --targets 1 --aim-lock \
    --output /dev/null --packets-out "$out/floater" --packets-wire 3 > "$out/floater.log" 2>&1 \
  || fail "floater repro crashed"
floating=$(python3 - <<'PY'
import json
rows = [json.loads(l) for l in open('/tmp/p1b-gates/floater/timings.jsonl')]
# A transient floater during a collapse is physics doing its job; a floater
# that SURVIVES to the end of the settle window is the frozen-mid-air bug.
# Gate on the final 300 ticks staying at zero.
print(max(r.get('floating', 0) for r in rows[-300:]))
PY
)
[ "$floating" = "0" ] || fail "floater repro tail has floating=$floating"
log "gate 2 green (final-300-tick floating=0)"

# ---- gate 3+4: collapse-onto-frozen-field A/B + perf number --------------
run_ab() { # $1 = label, $2 = extra env (VIBE_CITY_FREEZE_AGGREGATE)
  env VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32 \
      VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 VIBE_CITY_STRESS_LIMIT_SCALE=0.45 \
      VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 \
      VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
      VIBE_CITY_FREEZE_AGGREGATE="$2" \
    ./target/release/record-city-trace --scene destruction/assets/scenes/fractured-downtown.json \
      --grid 2 --seconds 140 --shots 40 --shot-interval-ticks 40 --targets 2 --aim-lock \
      --output /dev/null --packets-out "$out/$1" --packets-wire 3 > "$out/$1.log" 2>&1
}
log "gate 3/4: collapse A/B (aggregates on, then off)"
run_ab agg-on 1  || fail "agg-on trace crashed"
run_ab agg-off 0 || fail "agg-off trace crashed"
python3 - <<'PY' >> "$out/pipeline.log" 2>&1 || exit_code=$?
import json, statistics as st, sys
def load(p):
    return [json.loads(l) for l in open(f'/tmp/p1b-gates/{p}/timings.jsonl')]
on, off = load('agg-on'), load('agg-off')
bon, boff = on[-1]['bonds'], off[-1]['bonds']
# Same band the suite uses for run-to-run damage variance: the A/B must not
# differ MORE than two identical-config runs do (~60% documented). 40% here.
band = abs(bon - boff) / max(bon, boff)
def med(rows, lo, hi):
    xs = [r['sim'] for r in rows if lo <= r['frozen'] < hi]
    return st.median(xs) if len(xs) >= 30 else None
m_on, m_off = med(on, 800, 10**9), med(off, 800, 10**9)
print(f"A/B bonds on={bon} off={boff} band={band:.2%}")
print(f"perf: sim median at frozen>=800: on={m_on} off={m_off}")
sys.exit(0 if band <= 0.40 else 1)
PY
[ "${exit_code:-0}" = "0" ] || fail "collapse A/B bond band exceeded (see pipeline.log)"
log "gates 3/4 green"

# ---- deploy --------------------------------------------------------------
ln -f target/release/web-fps-server target/release/web-fps-server-vl4
log "hardlink refreshed; deploying"
restart
log "P1B GATE BATTERY GREEN AND DEPLOYED"
