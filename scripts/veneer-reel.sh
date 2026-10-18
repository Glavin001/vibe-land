#!/usr/bin/env bash
# The brick-veneer houses' reel (structures/town-kit veneer-houses.mjs): three
# in-app takes of client/native/films/veneer-houses.mjs, spliced in order --
#   bungalow as built, frame only, front-wall studs out (its collapse, filmed from tick 0);
#   two-storey the same; then the city cannonball and meteor into a bungalow.
# A house with its studs out starts falling on its first tick, so each
# collapse is a take of its own (scene veneer, VENEER_REEL).
#
#   scripts/veneer-reel.sh          -> target/native-video/veneer-reel-<stamp>.mp4 and -share.mp4
#
# 1080p60 (FILM_SIZE, FILM_FPS, FILM_SEED as for any film). Takes the GPU
# lock (target/native-bundle.lock) for each take and frees it however the take ends.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/target/native-bundle.lock"
export FILM_FPS="${FILM_FPS:-60}" FILM_SIZE="${FILM_SIZE:-1920x1080}" FILM_SEED="${FILM_SEED:-1}" FILM_CUT_FPS="${FILM_CUT_FPS:-60}" FILM_CHECK=0
node "$ROOT/structures/town-kit/scripts/build-veneer-reel.mjs"
take() {
  local reel="$1" log="$ROOT/target/native-video/veneer-reel-$1.out"
  until mkdir "$LOCK" 2>/dev/null; do sleep 15; done
  echo "veneer-reel $reel $$ $(date +%H:%M:%S)" > "$LOCK/owner"
  trap 'rm -rf "$LOCK"' EXIT
  VENEER_REEL="$reel" FILM_DEFINES="--define:VENEER_REEL=\"$reel\"" \
    "$ROOT/scripts/native-mac.sh" film veneer-houses --scene veneer > "$log" 2>&1 || { rm -rf "$LOCK"; echo "take $reel FAILED ($log)" >&2; exit 1; }
  rm -rf "$LOCK"; trap - EXIT
  grep -oE '/[^ ]*veneer-houses-[0-9-]+-final\.mp4' "$log" | head -1
}
standing=$(take standing); bungalow=$(take collapse-bungalow); house=$(take collapse-house)
echo "takes: $standing $bungalow $house"
out="$ROOT/target/native-video/veneer-reel-$(date +%Y%m%d-%H%M%S)"
# The standing take's shots: bungalow 0-20 s, two-storey 20-40 s, the weapons 40-53 s.
ffmpeg -v error -y -i "$standing" -i "$bungalow" -i "$house" -filter_complex "
  [0:v]trim=0:20,setpts=PTS-STARTPTS[a];[1:v]trim=0:10,setpts=PTS-STARTPTS[b];
  [0:v]trim=20:40,setpts=PTS-STARTPTS[c];[2:v]trim=0:10,setpts=PTS-STARTPTS[d];
  [0:v]trim=40:53,setpts=PTS-STARTPTS[e];[a][b][c][d][e]concat=n=5:v=1:a=0,fps=$FILM_FPS[v]" \
  -map "[v]" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart "$out.mp4"
seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out.mp4")
if [ "$(stat -f %z "$out.mp4")" -le 25000000 ]; then cp "$out.mp4" "$out-share.mp4"
else
  kbps=$(python3 -c "print(int(23.0 * 8000 / $seconds))")
  ffmpeg -v error -y -i "$out.mp4" -c:v libx264 -b:v "${kbps}k" -maxrate "${kbps}k" -bufsize "$((kbps * 2))k" -preset slow \
    -pix_fmt yuv420p -movflags +faststart "$out-share.mp4"
fi
ffmpeg -v error -y -i "$out.mp4" -vf "fps=1/6.5,scale=384:-2,tile=5x2:padding=3:margin=3" -frames:v 1 -q:v 3 "$out-sheet.jpg"
echo "reel: $out.mp4 (${seconds%.*} s); share $out-share.mp4; sheet $out-sheet.jpg"
