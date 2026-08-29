#!/usr/bin/env bash
# Experiment: does a mass-proportional contact-report threshold pay, and is it
# safe? (VIBE_CITY_CONTACT_REPORT_MASS_RATIO, plan Item 1.)
#
# Decides nothing by itself and changes no default: it runs the arms, prints a
# verdict table, and leaves the live server on whatever binary was serving.
# Deploying a winning k is a separate, deliberate step.
#
# Arms: unset (today), k=0.5 (conservative), k=2 (real saving).
# Per arm: scenario suite (T4 freeze health is THE safety gate — freeze
# admission learns supporters from these reports), then a matched trace.
# Verdict compares sim medians in joint awake/frozen buckets, plus the bond
# band (aggression must not change how much breaks) and floater tail.
set -uo pipefail
cd /root/workspace/vibe-land-4
out=/tmp/contact-threshold-exp
mkdir -p "$out"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$out/exp.log"; }

while true; do
  players=$(curl -s localhost:4005/healthz \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["players"])' 2>/dev/null || echo 1)
  [ "$players" = "0" ] && break
  sleep 60
done
log "player-free; stopping server for the GPU window"
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
BASE_ENV="BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0"

run_arm() { # $1 = label, $2 = ratio ("" = unset)
  local label=$1 ratio=$2
  local ratio_env=""
  [ -n "$ratio" ] && ratio_env="VIBE_CITY_CONTACT_REPORT_MASS_RATIO=$ratio"
  log "arm $label: scenario suite"
  env $ratio_env bash scripts/scenario-suite.sh > "$out/suite-$label.log" 2>&1
  echo "$?" > "$out/suite-$label.exit"
  log "arm $label: suite exit $(cat "$out/suite-$label.exit"); trace"
  rm -rf "$out/$label"
  # Shots stop at 40*40 ticks (~27 s); the rest is a SETTLE TAIL, which is
  # also plan Item 2's discriminator: in a quiet tail, thaws should stop.
  env $BASE_ENV $ratio_env VIBE_CITY_POSE_CENSUS=1 \
    ./target/release/record-city-trace \
      --scene destruction/assets/scenes/fractured-downtown.json \
      --grid 2 --seconds 200 --shots 40 --shot-interval-ticks 40 --targets 2 \
      --aim-lock --output /dev/null --packets-out "$out/$label" --packets-wire 3 \
      > "$out/trace-$label.log" 2>&1
  log "arm $label: trace exit $?"
}

run_arm unset ""
run_arm k05 0.5
run_arm k2 2

log "verdict"
python3 - <<'PY' 2>&1 | tee -a "$out/exp.log"
import json, statistics as st, os
OUT='/tmp/contact-threshold-exp'
def rows(label):
    p=f'{OUT}/{label}/timings.jsonl'
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []
def buckets(rs):
    b={}
    for r in rs: b.setdefault((r['awake']//500, r['frozen']//500), []).append(r['sim'])
    return b
arms={l:rows(l) for l in ('unset','k05','k2')}
base=arms['unset']
if not base:
    print('no baseline trace'); raise SystemExit
bb=buckets(base)
print(f"{'arm':>6} {'suite':>6} {'bonds':>7} {'bondΔ':>7} {'tail_thaw/s':>12} {'floaters':>9} {'Δsim_ms':>8}")
for label, rs in arms.items():
    if not rs: print(f"{label:>6}  NO TRACE"); continue
    suite=open(f'{OUT}/suite-{label}.exit').read().strip() if os.path.exists(f'{OUT}/suite-{label}.exit') else '?'
    bonds=rs[-1]['bonds']
    band=abs(bonds-base[-1]['bonds'])/max(bonds, base[-1]['bonds'], 1)
    # Settle tail: last 3000 ticks (50 s) are input-free in this recipe.
    tail=rs[-3000:]
    floaters=max(r.get('floating',0) for r in tail)
    # Weighted sim delta vs baseline over shared joint buckets.
    ab=buckets(rs); w=ws=0
    for k in set(ab)&set(bb):
        if len(ab[k])>=20 and len(bb[k])>=20:
            n=min(len(ab[k]),len(bb[k])); w+=(st.median(ab[k])-st.median(bb[k]))*n; ws+=n
    dsim=w/ws if ws else float('nan')
    print(f"{label:>6} {suite:>6} {bonds:>7} {band:>6.1%} {'n/a':>12} {floaters:>9} {dsim:>8.2f}")
print()
print("PASS for an arm: suite exit 0, bond band <= ~40% (GPU run-to-run), floaters <= baseline+1, Δsim negative.")
print("A negative Δsim with suite 0 is the payoff; T4 inside the suite is the safety gate.")
PY

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 8
curl -sk https://127.0.0.1:8384/healthz | head -c 40
echo
log "server restarted on the unchanged default; deploy a winning k deliberately"
