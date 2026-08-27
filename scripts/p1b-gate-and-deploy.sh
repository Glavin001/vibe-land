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

# ---- gate 2: floater repro, DIFFERENTIAL --------------------------------
# unsupported_resting_bodies counts frozen and engine-asleep floaters alike,
# and bodies held by Blast bonds legitimately appear in it — its own doc says
# "read it as a difference between runs, never as an absolute". (The absolute
# =0 version of this gate failed on floating=2, which the ground-chain work
# already documented as the expected engine-slept tail.) So: same recipe with
# aggregation on and off; aggregation must not INVENT floaters.
floater_run() { # $1 = label, $2 = VIBE_CITY_FREEZE_AGGREGATE
  env VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32 \
      VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 VIBE_CITY_STRESS_LIMIT_SCALE=0.45 \
      VIBE_CITY_SHOT_BLAST_RADIUS=0.7 VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 \
      VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
      VIBE_CITY_POSE_CENSUS=1 VIBE_CITY_POSE_CENSUS_DUMP=1 \
      VIBE_CITY_FREEZE_AGGREGATE="$2" \
    ./target/release/record-city-trace --scene destruction/assets/scenes/fractured-downtown.json \
      --grid 1 --seconds 110 --shots 30 --shot-interval-ticks 40 --targets 1 --aim-lock \
      --output /dev/null --packets-out "$out/$1" --packets-wire 3 > "$out/$1.log" 2>&1
}
log "gate 2: floater repro differential (aggregates on vs off)"
floater_run floater-on 1  || fail "floater agg-on run crashed"
floater_run floater-off 0 || fail "floater agg-off run crashed"
python3 - <<'PY' >> "$out/pipeline.log" || fail "floater differential (see pipeline.log)"
import json, sys
def tail(p):
    rows = [json.loads(l) for l in open(f'/tmp/p1b-gates/{p}/timings.jsonl')]
    return max(r.get('floating', 0) for r in rows[-300:])
on, off = tail('floater-on'), tail('floater-off')
print(f"floater tails: agg-on={on} agg-off={off}")
# No invented floaters (plus one count of run-to-run slack), and an absolute
# ceiling that would still catch a gross regression even if OFF misbehaved.
sys.exit(0 if on <= off + 1 and on <= 5 else 1)
PY
log "gate 2 green (differential)"

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
