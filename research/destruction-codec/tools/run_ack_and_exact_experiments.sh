#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACE="${1:-/root/workspace/codec-results/one-building-120hz-30s/collapse-v3-topology.towertrace}"
OUT="${2:-/root/workspace/codec-results/one-building-120hz-30s/ack-exact-experiments}"
LOSS="${3:-0.01}"

CARGO=(cargo)
for candidate in "$HOME"/.rustup/toolchains/stable-*/bin/cargo; do
  if [[ -x "$candidate" ]]; then
    export PATH="$(dirname "$candidate"):$PATH"
    break
  fi
done

mkdir -p "$OUT"

echo "== Ack-baseline adaptive omniscient (loss=${LOSS}) =="
"${CARGO[@]}" run --release -- ack-baseline \
  --trace "$TRACE" \
  --out-dir "$OUT/ack-baseline" \
  --loss-rate "$LOSS" \
  --ack-delay-ticks 0 \
  --baseline-interval-ms 1000 \
  --omniscient \
  --world-shell-budget-cm 2.0 \
  --output-fps 30

echo "== Ack-baseline adaptive interest + 45 Mbps ceiling (loss=${LOSS}) =="
"${CARGO[@]}" run --release -- ack-baseline \
  --trace "$TRACE" \
  --out-dir "$OUT/ack-baseline-interest-45" \
  --loss-rate "$LOSS" \
  --ack-delay-ticks 0 \
  --baseline-interval-ms 1000 \
  --single-view-interest \
  --bitrate-budget-mbps 45 \
  --output-fps 30

echo "== Exact-island-while-intact proxy =="
"${CARGO[@]}" run --release -- exact-island-proxy \
  --trace "$TRACE" \
  --output "$OUT/exact-island-proxy.towertrace" \
  --report "$OUT/exact-island-proxy.report.json" \
  --force

echo "== Hierarchy archive on exact-island proxy =="
"${CARGO[@]}" run --release -- archive \
  --trace "$OUT/exact-island-proxy.towertrace" \
  --out-dir "$OUT/hierarchy-exact-proxy" \
  --shell-error-mm 5 \
  --gop-ms 1000 \
  --max-segment-ms 250 \
  --cell-size-m 128 \
  --supercell-size-m 512 \
  --target-tracks 30 \
  --hard-track-cap 50 \
  --routes "$ROOT/benchmarks/spectator-routes.json"

echo "== Ground-truth replay for video compare =="
"${CARGO[@]}" run --release -- replay \
  --trace "$TRACE" \
  --output "$OUT/raw-authoritative.towerstate" \
  --output-fps 30

TOWER_DEMO="/root/workspace/physx-tower/tower-demo"
if [[ -d "$TOWER_DEMO" ]]; then
  echo "== Render videos =="
  (
    cd "$TOWER_DEMO"
    "${CARGO[@]}" run --release -- render \
      --state "$OUT/raw-authoritative.towerstate" \
      --output "$OUT/raw-authoritative.mp4"
    "${CARGO[@]}" run --release -- render \
      --state "$OUT/ack-baseline/ack-baseline-reconstructed.towerstate" \
      --output "$OUT/ack-baseline-reconstructed.mp4"
    if [[ -f "$OUT/hierarchy-exact-proxy/hierarchy-reconstructed.towerstate" ]]; then
      "${CARGO[@]}" run --release -- render \
        --state "$OUT/hierarchy-exact-proxy/hierarchy-reconstructed.towerstate" \
        --output "$OUT/hierarchy-exact-proxy-reconstructed.mp4"
    fi
  )
  if [[ -f "$OUT/ack-baseline/hierarchy_frame_telemetry.csv" ]]; then
    :
  fi
  # Compose ack-baseline proof using hierarchy telemetry format if needed: use simple ffmpeg hstack.
  if [[ -f "$OUT/raw-authoritative.mp4" && -f "$OUT/ack-baseline-reconstructed.mp4" ]]; then
    ffmpeg -y -loglevel error \
      -i "$OUT/raw-authoritative.mp4" \
      -i "$OUT/ack-baseline-reconstructed.mp4" \
      -filter_complex "[0:v]crop=960:540:960:540,drawtext=text='RAW':x=16:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[raw];[1:v]crop=960:540:960:540,drawtext=text='ACKED BASELINE 1% LOSS':x=16:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:expansion=none[ack];[raw][ack]hstack=inputs=2[out]" \
      -map "[out]" -an -c:v h264_nvenc -preset p5 -cq 18 -pix_fmt yuv420p \
      "$OUT/raw-vs-ack-baseline.mp4"
  fi
  if [[ -f "$OUT/raw-authoritative.mp4" && -f "$OUT/hierarchy-exact-proxy-reconstructed.mp4" ]]; then
    ffmpeg -y -loglevel error \
      -i "$OUT/raw-authoritative.mp4" \
      -i "$OUT/hierarchy-exact-proxy-reconstructed.mp4" \
      -filter_complex "[0:v]crop=960:540:960:540,drawtext=text='RAW PHYSX D6':x=16:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6[raw];[1:v]crop=960:540:960:540,drawtext=text='EXACT ISLAND PROXY HIERARCHY':x=16:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:expansion=none[exact];[raw][exact]hstack=inputs=2[out]" \
      -map "[out]" -an -c:v h264_nvenc -preset p5 -cq 18 -pix_fmt yuv420p \
      "$OUT/raw-vs-exact-island-hierarchy.mp4"
  fi
fi

python3 - <<PY
import json
from pathlib import Path
out = Path("$OUT")
summary = {"out_dir": str(out)}
ack = out / "ack-baseline/ack_baseline_report.json"
if ack.exists():
    summary["ack_baseline"] = json.loads(ack.read_text())
proxy = out / "exact-island-proxy.report.json"
if proxy.exists():
    summary["exact_island_proxy"] = json.loads(proxy.read_text())
hier = out / "hierarchy-exact-proxy/archive_report.json"
if hier.exists():
    h = json.loads(hier.read_text())["hierarchy"]
    summary["hierarchy_exact_proxy"] = {
        k: h.get(k)
        for k in [
            "compressed_bytes",
            "average_mbps",
            "baseline_seekable_bytes",
            "reduction_vs_independent_pct",
            "residual_pct_of_children",
            "selected_mode",
            "adopted",
            "max_shell_cm",
            "hierarchy_candidate_peak_gop_mbps",
        ]
    }
(out / "EXPERIMENT-SUMMARY.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
PY

echo "Done: $OUT"
