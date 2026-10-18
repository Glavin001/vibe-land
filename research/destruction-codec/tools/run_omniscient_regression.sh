#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/experiments/omniscient-regression}"
TRACE="$OUT/synthetic.towertrace"
CARGO=(cargo)
for candidate in "$HOME"/.rustup/toolchains/stable-*/bin/cargo; do
  if [[ -x "$candidate" ]]; then
    export PATH="$(dirname "$candidate"):$PATH"
    CARGO=(cargo)
    break
  fi
done

mkdir -p "$OUT"
"${CARGO[@]}" run --release -p destruction-codec --bin destruction-codec -- synthetic \
  --output "$TRACE" \
  --physics-hz 120 \
  --seconds 6 \
  --force
"${CARGO[@]}" run --release -p destruction-codec --bin destruction-codec -- archive \
  --trace "$TRACE" \
  --out-dir "$OUT/archive" \
  --shell-error-mm 5 \
  --gop-ms 1000 \
  --max-segment-ms 250 \
  --cell-size-m 128 \
  --supercell-size-m 512 \
  --target-tracks 30 \
  --hard-track-cap 50 \
  --routes "$ROOT/benchmarks/spectator-routes.json" \
  --require-pass

echo "Omniscient regression passed: $OUT/archive/archive_report.json"
