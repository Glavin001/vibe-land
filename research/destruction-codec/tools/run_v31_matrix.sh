#!/usr/bin/env bash
# The wire v3.1 rigor matrix: every scenario inside the 60 Hz physics
# envelope, recorded once per configuration, replayed through the SHIPPING
# client, judged by state-diff. This is the acceptance instrument for any
# codec change -- run it before claiming a number.
#
#   bash research/destruction-codec/tools/run_v31_matrix.sh [out-dir]
#
# Produces per-leg: packets dump (+timings), diff-<leg>.{json,txt},
# rate/accuracy summary. Legs share per-leg cleanup so peak disk stays
# ~3 GB. Budget-governed legs hold VIBE budget 5 Mbps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${1:-/tmp/v31-matrix}"
mkdir -p "$OUT"
export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.clang/release:${LD_LIBRARY_PATH:-}"

RECORD="$ROOT/target/release/record-city-trace"
CODEC="$ROOT/target/release/destruction-codec"

run_leg() {
  local name="$1"; shift
  local scene="$1"; shift
  local stress="$1"; shift
  echo "=== leg: $name (scene $scene, stress $stress) ==="
  VIBE_CITY_SCENE="$scene" VIBE_CITY_STRESS_LIMIT_SCALE="$stress" \
    "$RECORD" --output "$OUT/truth-$name.towertrace" \
    --packets-out "$OUT/$name" --packets-wire 3 "$@" 2>&1 |
    grep -E "peak bodies|note:" || true
  "$CODEC" replay --trace "$OUT/truth-$name.towertrace" \
    --output "$OUT/truth-$name.towerstate" >/dev/null
  rm -f "$OUT/truth-$name.towertrace"
  (cd "$ROOT/client" && npx tsx tools/replay-city-client.mts \
    --packets "$OUT/$name" --out "$OUT/client-$name.towerstate" 2>&1 |
    grep -v deprecated | tail -1)
  "$CODEC" state-diff --truth "$OUT/truth-$name.towerstate" \
    --client "$OUT/client-$name.towerstate" \
    --manifest "$OUT/$name/manifest.json" \
    --out "$OUT/diff-$name.json" >"$OUT/diff-$name.txt" 2>&1
  head -5 "$OUT/diff-$name.txt"
  python3 "$ROOT/research/destruction-codec/tools/packet_rate_overlay.py" \
    "$OUT/$name" "$OUT/$name.ass" "$name" --diff "$OUT/diff-$name.json" || true
  rm -f "$OUT/truth-$name.towerstate" "$OUT/client-$name.towerstate"
}

GOV=(--packets-span-ms 100 --packets-span-max-ms 250 --packets-budget-mbps 5)

# 1. Steady multi-building barrage (grid-2 city).
run_leg city-barrage high-rise-10f-local.json 0.10 \
  --grid 2 --hz 60 --seconds 45 --settle-ticks 60 --shots 40 --targets 3 \
  "${GOV[@]}"

# 2. Escalating district demolition (ramp to continuous fire).
run_leg downtown-ramp fractured-downtown.json 0.30 \
  --grid 1 --hz 60 --seconds 60 --settle-ticks 60 --shots 100 --targets 0 \
  --shot-interval-ticks 72 --shot-ramp-min-ticks 5 "${GOV[@]}"

# 3. Projectile storm on standing structures: many shots, strong bonds --
#    promotion bursts without mass collapse (reliable-channel stress).
run_leg projectile-storm fractured-downtown.json 1.0 \
  --grid 1 --hz 60 --seconds 45 --settle-ticks 30 --shots 120 --targets 0 \
  --shot-interval-ticks 20 --shot-ramp-min-ticks 6 "${GOV[@]}"

# 4. Settle-then-rewake: demolish, let the pile rest, hit it again --
#    park/wake churn and lane reuse under the epoch rule.
run_leg settle-rewake high-rise-10f-local.json 0.10 \
  --grid 2 --hz 60 --seconds 60 --settle-ticks 60 --shots 60 --targets 2 \
  --shot-interval-ticks 100 "${GOV[@]}"

echo
echo "=== matrix summary ==="
for diff in "$OUT"/diff-*.txt; do
  echo "--- $(basename "$diff") ---"
  head -5 "$diff"
done
echo "Browser-path legs (impairment, late join) run via netlab:"
echo "  npm run netlab -- run --scenario city-demolition-v3 --stack dev [--impair wifi-bad|lte]"
echo "  npm run netlab -- run --scenario city-latejoin --stack dev   # match cityv3-..."
