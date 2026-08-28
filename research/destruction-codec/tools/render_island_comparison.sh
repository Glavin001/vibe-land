#!/usr/bin/env bash
# Render ground truth against island-stream reconstructions at several error
# bounds, as one labelled grid a human can judge.
#
# Perceptual questions do not survive being answered with percentiles: "err p95
# 3.8 mm" means nothing until you watch the reconstruction next to the
# simulation and cannot tell them apart. This builds that comparison.
#
# Usage:
#   tools/render_island_comparison.sh TRACE OUT_DIR [bounds_cm...]
# Example:
#   tools/render_island_comparison.sh \
#     /root/workspace/codec-results/blast-one-building-60hz-30s/collapse.towertrace \
#     experiments/vids 0.5 20 100
#
# THE GOTCHA THIS SCRIPT EXISTS TO REMEMBER: hold --flush-ms FIXED across
# variants. The encode window is end-to-end latency, so a variant with a longer
# window renders the same tick SECONDS EARLIER in the collapse. A first attempt
# compared 0.5 cm at 250 ms against 20 cm at 2000 ms, and the coarse panes
# looked "less destroyed" -- that was 2 s of latency being read as a fidelity
# loss. Vary one axis at a time.
set -euo pipefail

TRACE="${1:?usage: render_island_comparison.sh TRACE OUT_DIR [bounds_cm...]}"
OUT="${2:?}"
shift 2
BOUNDS=("$@")
[[ ${#BOUNDS[@]} -eq 0 ]] && BOUNDS=(0.5 20 100)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CODEC="$ROOT/target/release/destruction-codec"
# The renderer still lives with the frozen D6 recorder; it only reads TWSTATE1.
RENDER="${TOWER_DEMO:-/root/workspace/physx-tower/tower-demo/target/release/tower-demo}"
FLUSH_MS="${FLUSH_MS:-250}"

mkdir -p "$OUT"
echo "== ground truth"
"$CODEC" replay --trace "$TRACE" --output "$OUT/truth.towerstate"
"$RENDER" render --state "$OUT/truth.towerstate" --output "$OUT/truth.mp4"

INPUTS=(-i "$OUT/truth.mp4")
FILTER="[0:v]crop=960:540:0:0,drawtext=text='GROUND TRUTH':x=20:y=18:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8[v0];"
IDX=1
for cm in "${BOUNDS[@]}"; do
  name="bound${cm/./p}"
  echo "== island stream at ${cm} cm"
  bytes=$("$CODEC" debris-codec --island-stream --trace "$TRACE" \
      --out-dir "$OUT/$name" --shell-cm "$cm" --flush-ms "$FLUSH_MS" \
    | tee /dev/stderr | grep -oP 'TOTAL          : \K[0-9]+')
  "$RENDER" render --state "$OUT/$name/reconstructed.towerstate" --output "$OUT/$name.mp4"
  kb=$(( bytes / 1024 ))
  INPUTS+=(-i "$OUT/$name.mp4")
  FILTER+="[${IDX}:v]crop=960:540:0:0,drawtext=text='${cm}cm bound   ${kb} KB':x=20:y=18:fontsize=28:fontcolor=lime:box=1:boxcolor=black@0.65:boxborderw=8[v${IDX}];"
  IDX=$((IDX + 1))
done

# 2x2 when there are four panes, otherwise a single row.
if [[ $IDX -eq 4 ]]; then
  FILTER+="[v0][v1]hstack[top];[v2][v3]hstack[bot];[top][bot]vstack[out]"
else
  FILTER+="$(printf '[v%d]' $(seq 0 $((IDX - 1))))hstack=inputs=${IDX}[out]"
fi

ffmpeg -y -v error "${INPUTS[@]}" -filter_complex "$FILTER" -map "[out]" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$OUT/compare.mp4"
echo "wrote $OUT/compare.mp4"

# Caddy's document root is /root/workspace (NOT /root/recordings -- that path
# is not served at all). See the recordings-web-server note.
PUBLISH="${PUBLISH_DIR:-}"
if [[ -n "$PUBLISH" ]]; then
  mkdir -p "/root/workspace/viewer-videos/$PUBLISH"
  cp "$OUT"/*.mp4 "/root/workspace/viewer-videos/$PUBLISH/"
  echo "published -> http://209.121.195.117:40616/viewer-videos/$PUBLISH/"
fi
