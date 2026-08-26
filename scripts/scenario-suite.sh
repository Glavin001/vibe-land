#!/usr/bin/env bash
# Destruction-quality gate: production code end to end, no QA required.
#
# Runs the real scene through the real arena (record-city-trace builds through
# production construction) and asserts on behaviour, not vibes:
#
#   T1  at-rest        a city nobody shoots must not fall down
#   T2  single shot    one shot breaks a bounded amount -- not nothing, not a building
#   T3  collapse shape a shelled tower must FALL and must TOPPLE/SPREAD,
#                      not pancake vertically in its own footprint
#   T4  freeze health  after the last shot, debris must retire; awake must fall.
#                      This alone would have caught the resim regression that
#                      shipped 90%-awake / 5-sleeping / 140 ms ticks.
#   T5  perf guard     tick p95 at matched load (3-6k awake) under threshold
#
# Thresholds live in bench-results/guardrails.json, recorded from a known-good
# build via --calibrate (with margins), so the suite tests "did this change
# break behaviour", not absolute physics truth.
#
#   scripts/scenario-suite.sh --calibrate   # record thresholds from this build
#   scripts/scenario-suite.sh               # gate
#
# Check the EXIT CODE directly -- `suite.sh | grep ...` reports grep's exit,
# not the suite's, which is precisely how its first failing run read as green.
#
# T3's collapse-shape bands are deliberately coarse: measured on identical
# inputs, height_retained swung 0.04 -> 0.25 and spread 0.75 -> 0.25 between
# two runs. One trial cannot meter fine feel; it CAN catch catastrophe
# (building doesn't fall at all / zero lateral spread). Fine-grained feel
# comparisons need n>=3 via bench-campaign.py and a video.
#
# Do NOT run while the server has players: two 24k-chunk scenes on one GPU has
# killed the server twice. The suite checks /healthz and refuses.
set -uo pipefail
cd "$(dirname "$0")/.."

GUARD=bench-results/guardrails.json
TRACE=./target/release/record-city-trace
SCENE=destruction/assets/scenes/fractured-downtown.json
OUT=/tmp/scenario-suite; mkdir -p "$OUT"

# Refuse whenever a server PROCESS exists, not just when someone is playing.
# An idle server still holds a 24k-chunk scene on the GPU, and running the
# suite beside one is how the server was silently killed twice -- the third
# near-miss was this very script being launched right after a restart.
# Only THIS repo's server: vibe-land-2 runs its own on this box and is not
# ours to stop -- refusing on any pgrep hit made the gate unrunnable.
REPO="$(pwd -P)"
for p in $(pgrep -x web-fps-server 2>/dev/null); do
  if [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$REPO" ]; then
    echo "REFUSING: this repo's web-fps-server is running (pid $p). Stop it first:"
    echo "  kill $p"
    exit 2
  fi
done

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32
export VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02
export VIBE_CITY_STRESS_LIMIT_SCALE="${VIBE_CITY_STRESS_LIMIT_SCALE:-0.45}"
export VIBE_CITY_SHOT_BLAST_RADIUS="${VIBE_CITY_SHOT_BLAST_RADIUS:-0.7}"
export VIBE_CITY_SHOT_STRESS_IMPULSE="${VIBE_CITY_SHOT_STRESS_IMPULSE:-4.0e7}"
export VIBE_CITY_EXCESS_FORCES="${VIBE_CITY_EXCESS_FORCES:-1}"
export VIBE_CITY_RESIM_PASSES="${VIBE_CITY_RESIM_PASSES:-0}"

MODE="${1:-gate}"

echo "== T2/T3 workloads (fixed aim, one tower) =="
# Adaptive first shot lands on real geometry; --aim-lock keeps every later
# shot on that same building. The summary target is the first hit point, so
# the metrics measure the building that was actually shot.
"$TRACE" --scene "$SCENE" --grid 1 --seconds 8 \
  --shots 1 --targets 1 --aim-lock --output /dev/null \
  --summary-out "$OUT/t2.json" --metrics-out "$OUT/t2.csv" >/dev/null 2>&1 \
  || { echo "FAIL: T2 run crashed"; exit 1; }
"$TRACE" --scene "$SCENE" --grid 1 --seconds 40 \
  --shots 12 --shot-interval-ticks 10 --targets 1 --aim-lock --output /dev/null \
  --summary-out "$OUT/t3.json" --metrics-out "$OUT/t3.csv" >/dev/null 2>&1 \
  || { echo "FAIL: T3 run crashed"; exit 1; }
echo "== T5 workload (full bombardment) =="
"$TRACE" --scene "$SCENE" --grid 1 --seconds 25 --shots 600 \
  --shot-interval-ticks 4 --targets 27 --output /dev/null \
  --metrics-out "$OUT/t5.csv" >/dev/null 2>&1 \
  || { echo "FAIL: T5 run crashed"; exit 1; }

python3 - "$MODE" "$OUT" "$GUARD" <<'PY'
import csv, json, statistics as st, sys
mode, out, guard_path = sys.argv[1], sys.argv[2], sys.argv[3]

t2 = json.load(open(f"{out}/t2.json")); t3 = json.load(open(f"{out}/t3.json"))
t3rows = [r for r in csv.DictReader(open(f"{out}/t3.csv")) if float(r["tick"]) > 0]
t5rows = [r for r in csv.DictReader(open(f"{out}/t5.csv")) if float(r["tick"]) > 0]

# T4 inputs, from the T3 run: the tail after everything settles.
tail = t3rows[-300:]                       # final 5 s
awake_peak = max(float(r["awake"]) for r in t3rows)
awake_end = st.median(float(r["awake"]) for r in tail)
bodies_end = float(t3rows[-1]["bodies"])
retired_end = st.median(float(r["frozen"]) + float(r["sleeping"]) for r in tail)
retired_frac = retired_end / max(bodies_end, 1)

# T5: p95 of full tick at matched load.
sel = [float(r["physx_step"]) + float(r["stress_solve"]) for r in t5rows
       if 3000 <= float(r["awake"]) < 6000]
p95 = sorted(sel)[int(len(sel) * 0.95)] if len(sel) >= 20 else None

measured = {
    "t2_bonds": t2["broken_bonds"], "t2_bodies": t2["chunk_bodies"],
    "t3_height_retained": t3["height_retained"],
    "t3_spread_fraction": t3["spread_fraction"],
    "t4_retired_fraction": round(retired_frac, 3),
    "t4_awake_end_over_peak": round(awake_end / max(awake_peak, 1), 3),
    "t5_p95_ms": round(p95, 1) if p95 else None,
    "t5_bucket_ticks": len(sel),
}
print("measured:", json.dumps(measured))

if mode == "--calibrate":
    guards = {
        # Bands, not points: GPU damage variance is 10-60%.
        "t2_bonds_min": max(3, int(measured["t2_bonds"] * 0.25)),
        "t2_bonds_max": int(max(measured["t2_bonds"] * 4, 50)),
        "t2_bodies_max": int(max((measured["t2_bodies"] - 27) * 5 + 27, 200)),
        # Coarse on purpose: collapse shape varies wildly between identical
        # runs (retained 0.04 vs 0.25 measured back to back). These bands catch
        # "did not fall" and "no lateral motion at all", nothing finer.
        "t3_height_retained_max": max(0.55, min(0.95, measured["t3_height_retained"] + 0.30)),
        "t3_spread_fraction_min": min(0.10, round(measured["t3_spread_fraction"] * 0.4, 3)),
        "t4_retired_fraction_min": round(min(0.60, measured["t4_retired_fraction"] * 0.7), 3),
        "t4_awake_end_over_peak_max": round(min(0.9, measured["t4_awake_end_over_peak"] * 2 + 0.1), 3),
        "t5_p95_ms_max": round(measured["t5_p95_ms"] * 1.35, 1) if measured["t5_p95_ms"] else 60.0,
        "calibrated_from": measured,
    }
    import os; os.makedirs("bench-results", exist_ok=True)
    json.dump(guards, open(guard_path, "w"), indent=1)
    print(f"wrote {guard_path}")
    sys.exit(0)

g = json.load(open(guard_path))
checks = [
    ("T2 bonds >= min",        measured["t2_bonds"] >= g["t2_bonds_min"],
     f"{measured['t2_bonds']} vs >= {g['t2_bonds_min']} (too weak)"),
    ("T2 bonds <= max",        measured["t2_bonds"] <= g["t2_bonds_max"],
     f"{measured['t2_bonds']} vs <= {g['t2_bonds_max']} (one shot pulverizes)"),
    ("T2 bodies bounded",      measured["t2_bodies"] <= g["t2_bodies_max"],
     f"{measured['t2_bodies']} vs <= {g['t2_bodies_max']} (runaway cascade)"),
    ("T3 tower fell",          measured["t3_height_retained"] <= g["t3_height_retained_max"],
     f"retained {measured['t3_height_retained']:.2f} vs <= {g['t3_height_retained_max']:.2f}"),
    ("T3 toppled/spread",      measured["t3_spread_fraction"] >= g["t3_spread_fraction_min"],
     f"spread {measured['t3_spread_fraction']:.2f} vs >= {g['t3_spread_fraction_min']:.2f} (pancaked in place)"),
    ("T4 debris retired",      measured["t4_retired_fraction"] >= g["t4_retired_fraction_min"],
     f"retired {measured['t4_retired_fraction']:.2f} vs >= {g['t4_retired_fraction_min']:.2f} (freeze starved)"),
    ("T4 awake declined",      measured["t4_awake_end_over_peak"] <= g["t4_awake_end_over_peak_max"],
     f"end/peak {measured['t4_awake_end_over_peak']:.2f} vs <= {g['t4_awake_end_over_peak_max']:.2f}"),
]
# T6: escape/buffer health, from the heaviest run. An escaped body falls
# forever, its CCD envelope explodes the broadphase, and the patch buffer
# overflow silently drops contacts -- measured live: min_body_y -19.6M m,
# patches 547,670/524,288, gpu_wait 344 ms.
import os
patch_cap = int(os.environ.get("VIBE_PHYSX_GPU_MAX_RIGID_PATCHES", "2097152"))
min_y = min(float(r["min_y"]) for r in t5rows + t3rows)
patch_max = max(int(float(r.get("patch_hw", 0))) for r in t5rows)
escaped = max(int(float(r.get("escaped", 0))) for r in t5rows + t3rows)
# Containment, not perfection: tunnelling during heavy collapse is a real,
# reproducible defect (7 escapes in this suite's own first armed run) tracked
# separately. What the gate enforces is that an escapee is PARKED promptly --
# a runaway (min_y in the kilometres) means the kill floor stopped working and
# the CCD/broadphase poison spiral is back.
checks.append(("T6 escapes contained", min_y > -1000.0 and escaped <= 20,
               f"min_y {min_y:.1f} (>-1000), escaped-parked {escaped} (<=20)"))
checks.append(("T6 patch buffer headroom", patch_max <= patch_cap * 0.9,
               f"{patch_max} vs <= {int(patch_cap*0.9)} (overflow drops contacts)"))

if measured["t5_p95_ms"] is not None:
    checks.append(("T5 perf p95 @3-6k awake", measured["t5_p95_ms"] <= g["t5_p95_ms_max"],
                   f"{measured['t5_p95_ms']} ms vs <= {g['t5_p95_ms_max']} ms"))
else:
    print("  note: T5 bucket underpopulated; perf guard skipped this run")

failed = 0
for name, ok, detail in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {name:26s} {detail}")
    failed += 0 if ok else 1
sys.exit(1 if failed else 0)
PY
SUITE=$?

echo "== T1 at-rest =="
./scripts/check-at-rest.sh "${VIBE_CITY_STRESS_LIMIT_SCALE}" 90 || exit 1
exit $SUITE
