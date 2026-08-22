#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/target/hierarchy-regression}"
CARGO=(cargo)
for candidate in "$HOME"/.rustup/toolchains/stable-*/bin/cargo; do
  if [[ -x "$candidate" ]]; then
    export PATH="$(dirname "$candidate"):$PATH"
    CARGO=(cargo)
    break
  fi
done

mkdir -p "$OUT"

# Approximate D6 topology fixture (shared global IDs, breakable edges).
"${CARGO[@]}" run --release -p destruction-codec --bin destruction-codec -- synthetic \
  --output "$OUT/d6-topology.towertrace" \
  --physics-hz 120 \
  --seconds 6 \
  --actors 4 \
  --force

# Exact Blast-style rigid islands with baked locals and shared global IDs.
"${CARGO[@]}" run --release -p destruction-codec --bin destruction-codec -- synthetic \
  --output "$OUT/blast-exact-islands.towertrace" \
  --physics-hz 120 \
  --seconds 6 \
  --exact-islands \
  --actors 48 \
  --island-size 8 \
  --force

for TRACE in d6-topology blast-exact-islands; do
  DIR="$OUT/$TRACE"
  "${CARGO[@]}" run --release -p destruction-codec --bin destruction-codec -- archive \
    --trace "$OUT/$TRACE.towertrace" \
    --out-dir "$DIR" \
    --shell-error-mm 5 \
    --gop-ms 1000 \
    --max-segment-ms 250 \
    --cell-size-m 128 \
    --supercell-size-m 512 \
    --target-tracks 30 \
    --hard-track-cap 50 \
    --routes "$ROOT/benchmarks/spectator-routes.json" \
    --require-pass
  python3 - <<PY
import json
report = json.load(open("$DIR/archive_report.json"))
h = report["hierarchy"]
assert h["shared_manifest"], "shared manifest required"
assert h["post_zstd_decode_pass"], "post-zstd hierarchy decode failed"
assert h["exact_event_pass"], "hierarchy event mismatch"
assert h["max_active_tracks"] <= 30, "track target exceeded"
print(
    f"{'$TRACE'}: topology={h['topology_available']} "
    f"mode={h['selected_mode']} "
    f"delivered={h['reduction_vs_independent_pct']:.2f}% "
    f"candidate={h['hierarchy_candidate_reduction_vs_independent_pct']:.2f}% "
    f"adopted={h['adopted']} "
    f"omitted={h['omitted_child_pose_records']} "
    f"residuals={h['residual_pose_records']}"
)
PY
done

echo "Hierarchy regression passed: $OUT"
