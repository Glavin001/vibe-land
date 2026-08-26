#!/usr/bin/env bash
# A city that nobody shoots must not fall down.
#
# This exists because it was skipped. Chasing "damage feels too weak" I dropped
# VIBE_CITY_STRESS_LIMIT_SCALE from 0.6 to 0.12 -- the value the CUDA solver's
# own startup banner recommends -- shipped it, and the city began demolishing
# itself under gravity: 8,248 bonds broken in 20 seconds with zero players
# connected. The damage measurement was right and the invariant was never
# checked.
#
# Run before deploying ANY material, gravity, solver-iteration or scene change.
#
#   scripts/check-at-rest.sh [scale] [seconds]
#
# Exit 0 = stands up. Exit 1 = it is eating itself.
set -uo pipefail
cd "$(dirname "$0")/.."

SCALE="${1:-${VIBE_CITY_STRESS_LIMIT_SCALE:-0.45}}"
SECONDS_RUN="${2:-90}"
# Budget, not zero: a settling structure creaks a little as it beds onto the
# ground. Measured at 0.45 this is 4 bonds in 90 s and flat thereafter; at 0.3
# it is 16 and still climbing, which is decay rather than settling.
BUDGET="${AT_REST_BUDGET:-30}"

export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_SOLVER_ITERATIONS=32
export VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02
export VIBE_CITY_STRESS_LIMIT_SCALE="$SCALE"

CSV=$(mktemp /tmp/at-rest-XXXX.csv)
trap 'rm -f "$CSV"' EXIT

echo "at-rest check: scale=$SCALE, ${SECONDS_RUN}s, zero shots, budget ${BUDGET} bonds"
./target/release/record-city-trace \
  --scene destruction/assets/scenes/fractured-downtown.json --grid 1 \
  --seconds "$SECONDS_RUN" --shots 0 --targets 27 \
  --output /dev/null --metrics-out "$CSV" >/dev/null 2>&1 || {
    echo "FAIL: trace did not complete"; exit 1; }

python3 - "$CSV" "$BUDGET" <<'PY'
import csv, sys
rows=[r for r in csv.DictReader(open(sys.argv[1])) if float(r["tick"])>0]
budget=int(sys.argv[2])
b=[float(r["bonds"]) for r in rows]
total=b[-1]
# The shape matters more than the total: settling stops, decay does not.
tail=b[-1]-b[max(0,len(b)-len(b)//3)]
print(f"  bonds broken total: {total:.0f}")
print(f"  broken in final third: {tail:.0f}")
ok = total <= budget and tail <= max(2, budget//10)
print("  PASS: the city stands up" if ok else
      "  FAIL: the city is destroying itself with nobody shooting it")
sys.exit(0 if ok else 1)
PY
