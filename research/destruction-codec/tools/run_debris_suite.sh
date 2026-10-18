#!/usr/bin/env bash
# Scenario suite for the per-body debris codec.
#
# The reference trace is one impact followed by 25 s of settling, so a result
# measured only there says nothing about sustained multi-region load, airborne
# bursts, or piles that get re-disturbed after coming to rest. Each scenario
# below targets one regime that could plausibly break the codec, and both
# codecs are measured on the SAME trace under the SAME fidelity contract.
#
# Traces are 0.5-3 GB and regenerate deterministically from their seed, so each
# is generated, measured by both codecs, and deleted before the next one starts
# (record -> measure -> delete, as the L1 suite established).
#
# Usage: tools/run_debris_suite.sh [scenario-id ...]   (default: all)
set -euo pipefail

CODEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOWER_DIR="$CODEC_DIR/../physx-tower/tower-demo"
CODEC="$CODEC_DIR/target/release/destruction-codec"
TOWER="$TOWER_DIR/target/release/tower-demo"
OUT_ROOT="${DEBRIS_SUITE_OUT:-$CODEC_DIR/experiments/debris-suite}"
TRACE_DIR="${DEBRIS_SUITE_TRACES:-/root/debris-suite-traces}"

# id|buildings|seed|shots|duration|shot_delay_max|regime
SCENARIOS=(
  "D1-offaxis|1|7|3|10|2.5|glancing off-axis impact, calibration transfer"
  "D2-twobldg|2|11|6|10|2.5|high duty cycle, debris vs an intact building"
  "D3-threebldg|3|23|8|10|2.5|18k actors, sustained multi-region load"
  "D4-airburst|1|101|10|10|2.5|airborne-dominated, maximum shot density"
  "D5-churn|1|202|8|20|8.0|impacts into an already-settled pile"
  "D6-scale|4|31|10|6|2.5|24k actors, encoder throughput extreme"
)

mkdir -p "$OUT_ROOT" "$TRACE_DIR"

measure() {
  local id="$1" trace="$2" out="$3"
  mkdir -p "$out/live" "$out/debris"

  echo "--- $id: incumbent (live hierarchy) ---"
  local live_start live_elapsed
  live_start=$(date +%s.%N)
  "$CODEC" analyze --trace "$trace" --out-dir "$out/live" \
    --omniscient --telemetry-only --live-hierarchy --hier-gop-ms 250 \
    --world-shell-budget-cm 0.5 --snapshot-fps 120 --output-fps 30 \
    --mask-precision --mask-cap-mm 20 >"$out/live/stdout.txt" 2>&1 || echo "  (incumbent run failed; see stdout.txt)"
  live_elapsed=$(echo "$(date +%s.%N) - $live_start" | bc)
  echo "  wall ${live_elapsed}s"

  echo "--- $id: debris-codec ---"
  local debris_start debris_elapsed
  debris_start=$(date +%s.%N)
  "$CODEC" debris-codec --trace "$trace" --out-dir "$out/debris" \
    --shell-cm 0.5 --mask-precision --mask-cap-mm 20 --flush-ms 250 \
    --output-fps 30 --interpolation-delay-ms 100 \
    2>&1 | tee "$out/debris/stdout.txt"
  debris_elapsed=$(echo "$(date +%s.%N) - $debris_start" | bc)
  echo "  wall ${debris_elapsed}s"

  # Replays are hundreds of MB and only needed for visual A/B on demand.
  if [[ "${DEBRIS_SUITE_KEEP_REPLAY:-0}" != "1" ]]; then
    rm -f "$out/live/reconstructed.towerstate" "$out/debris/reconstructed.towerstate" \
          "$out/live/raw.towerstate" "$out/live"/*.towerstate 2>/dev/null || true
  fi

  python3 - "$id" "$out" "$live_elapsed" "$debris_elapsed" <<'PY'
import json, os, sys
scenario, out, live_wall, debris_wall = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
row = {"scenario": scenario}
try:
    metrics = json.load(open(f"{out}/live/video_metrics.json"))
    live = metrics["live_hierarchy"]
    # The incumbent's acceptance block sits at the top level, not under
    # live_hierarchy, and is the whole point of the comparison.
    gate = metrics.get("visual_acceptance", {})
    row["live"] = {
        "bytes": live["compressed_bytes"], "avg_mbps": live["average_mbps"],
        "p95_mbps": live["p95_block_mbps"], "peak_mbps": live["peak_block_mbps"],
        "gate": gate.get("pass"),
        "freeze_run_ms": gate.get("frame_freeze_run_ms_max"),
        "reversal_max": gate.get("frame_linear_reversal_pct_max"),
        "reversal_p99": gate.get("frame_linear_reversal_pct_p99"),
        "encode_realtime_x": live.get("realtime_encode_factor"),
        "wall_s": live_wall,
    }
except Exception as exc:
    row["live"] = {"error": str(exc), "wall_s": live_wall}
d = json.load(open(f"{out}/debris/debris_report.json"))
row["debris"] = {
    "bytes": d["compressed_bytes"], "avg_mbps": d["average_mbps"],
    "p95_mbps": d["p95_block_mbps"], "peak_mbps": d["peak_block_mbps"],
    "gate": d["acceptance"]["pass"], "wall_s": debris_wall,
    "bodies": d["bodies"], "ticks": d["ticks"], "duration_s": d["duration_seconds"],
    "fallback": d["fallback_fraction"],
    "analytic_payload_pct": 100.0 * (d["segment_bytes"] + d["impulse_bytes"]) / max(1, d["uncompressed_bytes"]),
    "sample_run_pct": 100.0 * d["sample_run_bytes"] / max(1, d["uncompressed_bytes"]),
    "max_err_cm": d["max_shell_error_cm"], "p95_err_cm": d["p95_shell_error_cm"],
    "violations": d["tolerance_violations"], "rests": d["rests"],
    "freeze_run_ms": d["acceptance"]["frame_freeze_run_ms_max"],
    "reversal_max": d["acceptance"]["frame_linear_reversal_pct_max"],
}
lb = row.get("live", {}).get("bytes")
if lb:
    row["ratio_vs_live"] = lb / d["compressed_bytes"]
    row["realtime_x"] = {"live": live_wall / d["duration_seconds"], "debris": debris_wall / d["duration_seconds"]}
json.dump(row, open(f"{out}/summary.json", "w"), indent=2)
print(json.dumps(row, indent=2))
PY
}

run_scenario() {
  local spec="$1"
  IFS='|' read -r id buildings seed shots duration delay regime <<<"$spec"
  local out="$OUT_ROOT/$id"
  local trace="$TRACE_DIR/$id.towertrace"

  if [[ -f "$out/summary.json" && "${DEBRIS_SUITE_FORCE:-0}" != "1" ]]; then
    echo "=== $id: already measured, skipping ==="
    return 0
  fi

  echo "=========================================================="
  echo "=== $id  ($regime)"
  echo "===   $buildings building(s), seed $seed, $shots shots, ${duration}s, delay<=${delay}s"
  echo "=========================================================="
  "$TOWER" trace --duration "$duration" --settle 0 --buildings "$buildings" \
    --seed "$seed" --shots "$shots" --snapshot-fps 120 --substeps 1 \
    --shot-delay-max "$delay" --output "$trace" 2>&1 | tail -3

  measure "$id" "$trace" "$out"
  rm -f "$trace"
  df -h /root | tail -1
}

selected=("$@")
for spec in "${SCENARIOS[@]}"; do
  id="${spec%%|*}"
  if [[ ${#selected[@]} -gt 0 ]]; then
    match=0
    for want in "${selected[@]}"; do [[ "$want" == "$id" ]] && match=1; done
    [[ $match -eq 1 ]] || continue
  fi
  run_scenario "$spec"
done

echo "=== suite complete; summaries under $OUT_ROOT ==="
