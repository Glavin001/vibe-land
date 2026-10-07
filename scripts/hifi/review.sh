#!/bin/bash
# Stills for judging a film by eye: a timestamped contact sheet.
#   scripts/hifi/review.sh VIDEO [FROM TO FPS COLS]   (defaults: whole film, 2 fps, 6 columns)
# Writes VIDEO-review-FROM-TO.jpg; each tile carries its video time.
set -euo pipefail
video=$1 from=${2:-0} to=${3:-} fps=${4:-2} cols=${5:-6}
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")
to=${to:-$dur}
n=$(python3 -c "import math;print(max(1,math.ceil(($to-$from)*$fps)))")
rows=$(( (n + cols - 1) / cols ))
out="${video%.mp4}-review-$from-$to.jpg"
ffmpeg -v error -y -ss "$from" -t "$(python3 -c "print($to-$from)")" -i "$video" \
  -vf "fps=$fps,scale=400:-2,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{pts\:hms\:$from}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=${cols}x${rows}:padding=3:margin=3" \
  -frames:v 1 -q:v 3 "$out"
echo "$out"
