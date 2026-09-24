#!/bin/bash
# Cut the two recordings into clips and join them with title and end cards.
#   client/e2e/mac-demo/assemble.sh <terrain.webm> <city.webm> [out dir]
# Trim points are for the takes recorded on 2026-09-23; adjust per take.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
T=$1; C=$2; O=${3:-$ROOT/target/demo-videos}
mkdir -p "$O"; W=$(mktemp -d "$O/.assemble.XXXX"); trap 'rm -rf "$W"' EXIT
F=/System/Library/Fonts/Menlo.ttc
enc=(-c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 30)
ffmpeg -v error -y -i "$T" -filter_complex "[0:v]trim=0:58,setpts=PTS-STARTPTS[a];[0:v]trim=128:180,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]" -map "[v]" "${enc[@]}" "$O/01-terrain-vehicle-balls.mp4"
ffmpeg -v error -y -ss 5 -to 72 -i "$C" "${enc[@]}" "$O/02-city-destruction-and-car.mp4"
card() { ffmpeg -v error -y -f lavfi -i "color=c=0x101418:s=1280x720:d=${2}:r=30" -vf "drawtext=fontfile=$F:textfile=$1:fontcolor=white:fontsize=26:line_spacing=10:x=70:y=(h-text_h)/2" "${enc[@]}" "$3"; }
card "$HERE/title.txt" 7 "$W/title.mp4"
card "$HERE/end.txt" 10 "$W/end.mp4"
printf "file '%s'\nfile '%s'\nfile '%s'\nfile '%s'\n" "$W/title.mp4" "$O/01-terrain-vehicle-balls.mp4" "$O/02-city-destruction-and-car.mp4" "$W/end.mp4" > "$W/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$W/list.txt" -c copy "$O/vibe-land-mac-metal-demo.mp4"
ls -la "$O"
