#!/usr/bin/env bash
# Render what a simulated viewer actually receives, as a video a human can judge.
#
# Numbers could not settle the far-tier question ("67% of bodies unsourced"
# sounded fatal; on screen the buildings survive and the debris plumes thin) --
# perceptual trade-offs need eyes. This wraps the whole pipeline:
#
#   debris-tracks --render-viewer  ->  view-*.towerstate (+ truth-*)
#   tower-demo render              ->  mp4 (2x2 grid, or 4x identical panes)
#   ffmpeg crop (solo mode)        ->  true 1080p single-camera video
#
# The viewer recording is honest by construction: a body with no usable
# subscribed source is never written, so missing coverage renders as missing
# geometry. Truth is written alongside from the same camera for A/B.
#
# Usage:
#   tools/render_viewer_video.sh TRACE OUT_DIR NAME [debris-tracks args...]
# Examples:
#   # far-tier A/B (coarse-only spectator), 4-pane grid:
#   tools/render_viewer_video.sh /root/w9.towertrace experiments/vv far-all \
#     --splits PS2 --subscribes SS5 --render-viewer birds-eye \
#     --far-flush-ms 2000 --coarse-max-stride 240 --coarse-step-exp 7
#   # full-res solo tourist:
#   tools/render_viewer_video.sh /root/w9.towertrace experiments/vv tour \
#     --splits PS2 --subscribes SS2 --render-viewer roaming-tourist --render-solo
#
# Gotchas this script exists to remember:
# - Do NOT swallow stderr from debris-tracks: a failed ReplayWriter::finish
#   (frame-count mismatch) still leaves a plausible-looking file behind.
# - --render-solo writes the viewer camera into all four panes at native 1080p;
#   the top-left quadrant is cropped out, giving real 1920x1080 (the grid panes
#   are only 960x540 each).
# - Viewer kinds: roaming-tourist (smooth pan -- the one to judge motion by),
#   birds-eye (static, whole map), action-follower / teleporter (hotspot
#   chasers: they jump BY DESIGN; do not use them to judge camera smoothness).
# - Videos are served from /root/workspace (Caddy :8082, basic-auth), public at
#   http://209.121.195.117:40616/ -- copy outputs under /root/workspace/ to share.
set -euo pipefail

TRACE="$1"; OUT_DIR="$2"; NAME="$3"; shift 3

CODEC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOWER="$CODEC_DIR/../physx-tower/tower-demo/target/release/tower-demo"
CODEC="$CODEC_DIR/target/release/destruction-codec"
PUBLISH_DIR="${VIEWER_VIDEO_PUBLISH:-/root/workspace/viewer-videos}"

mkdir -p "$OUT_DIR" "$PUBLISH_DIR"

# stderr stays visible; a ReplayWriter error must fail the run.
"$CODEC" debris-tracks --trace "$TRACE" --out-dir "$OUT_DIR" "$@"

SOLO=0
for arg in "$@"; do [[ "$arg" == "--render-solo" ]] && SOLO=1; done

shopt -s nullglob
for state in "$OUT_DIR"/view-*.towerstate "$OUT_DIR"/truth-*.towerstate; do
  base="$(basename "$state" .towerstate)"
  kind="${base%%-*}" # view | truth
  raw="$OUT_DIR/$base.mp4"
  "$TOWER" render --state "$state" --output "$raw"
  final="$PUBLISH_DIR/$NAME-$kind.mp4"
  if [[ "$SOLO" == "1" ]]; then
    # Four identical panes at 2x1080p; crop one to a true-resolution solo video.
    ffmpeg -y -loglevel error -i "$raw" -filter:v "crop=1920:1080:0:0" \
      -c:v libx264 -crf 18 -preset medium "$final"
  else
    cp "$raw" "$final"
  fi
  echo "published: $final"
done

echo "serve URL: http://209.121.195.117:40616/${PUBLISH_DIR#/root/workspace/}/"
