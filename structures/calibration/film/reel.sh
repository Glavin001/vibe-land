#!/usr/bin/env bash
# A calibration scenario's reel (structures/calibration): in the native app,
# an overview of every case side by side, then each case alone, each its own
# take from tick 0 (client/native/films/calibration.mjs), the opening frame
# held with the case and the hand calculation's prediction before it moves,
# then what the engine did, measured during the take; spliced in order.
#
#   structures/calibration/film/reel.sh SCENARIO
#     -> target/native-video/calibration-SCENARIO-<stamp>.mp4, -share.mp4 (under 25 MB), -sheet.jpg
#
# Reads structures/calibration/out/SCENARIO/{spec,scene,verdict}.json (run.mjs
# writes them; `--spec-only` is enough, verdict.json is optional) -- the
# contract is in calibration.mjs's header. Each case's take loads that case
# alone (case-scene.mjs, target/calib-film/SCENARIO/<case>.json).
#
#   CALIB_CONFIG   engine configuration (structures/calibration/src/configs.mjs):
#                  section (default), default or rotation; its env is set here
#   CALIB_CASES    the cases, comma list (default: every case): a take each, and the
#                  overview shows only them; CALIB_OVERVIEW=0 skips the overview
#   CALIB_FREEZE   seconds the opening frame is held (default 4)
#   FILM_SIZE, FILM_FPS, FILM_SEED   as for any film (default 1280x720, 30)
#   VIBE_SIM_TARGET, NATIVE_SKIP_SIM  the simulation library (scripts/native-mac.sh sim())
#
# Correctness runs share the GPU (VIBE_GPU_SHARED=1: no lock). The shared
# client/dist-native bundle: a take waits while target/native-bundle.lock is
# held by someone else (it does not take it), and while any other app film runs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCENARIO="${1:?usage: reel.sh SCENARIO}"
DIR="$ROOT/structures/calibration/out/$SCENARIO"
CONFIG="${CALIB_CONFIG:-section}"
FREEZE="${CALIB_FREEZE:-4}"
export FILM_FPS="${FILM_FPS:-30}" FILM_SIZE="${FILM_SIZE:-1280x720}" FILM_SEED="${FILM_SEED:-1}" FILM_CHECK=0 FILM_PREVIEW=0
export VIBE_GPU_SHARED=1
VIDEO="$ROOT/target/native-video"
mkdir -p "$VIDEO" "$ROOT/target/calib-film/$SCENARIO"

[ -f "$DIR/spec.json" ] && [ -f "$DIR/scene.json" ] || node "$ROOT/structures/calibration/run.mjs" "$SCENARIO" --spec-only
# The configuration's environment (only the VIBE_SECTION_* switches the configs use), and the
# player's spawn well clear of everything: 120 m beyond the scene's -z side, at its middle.
eval "$(node --input-type=module -e "
import { CONFIGS } from '$ROOT/structures/calibration/src/configs.mjs';
import { readFileSync } from 'node:fs';
const c = CONFIGS[process.argv[1]];
if (!c) { console.error('no config ' + process.argv[1] + ' (' + Object.keys(CONFIGS).join(', ') + ')'); process.exit(2); }
const env = { VIBE_SECTION_BENDING: '0', VIBE_SECTION_ROTATION: '0', VIBE_IMPACT_CAPACITY: '0', ...c.env };
const s = JSON.parse(readFileSync('$DIR/scene.json', 'utf8')).scenario;
const xs = s.nodes.map((n) => n.centroid.x), zs = s.nodes.map((n) => n.centroid.z);
env.CALIB_SPAWN_X = ((Math.min(...xs) + Math.max(...xs)) / 2).toFixed(1);
env.CALIB_SPAWN_Z = (Math.min(...zs) - 120).toFixed(1);
for (const [k, v] of Object.entries(env)) console.log('export ' + k + '=' + JSON.stringify(v));
" "$CONFIG")"
cases="${CALIB_CASES:-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).cases.map((c) => c.id).join(","))' "$DIR/spec.json")}"
takes=()
[ "${CALIB_OVERVIEW:-1}" = 1 ] && takes+=(overview)
IFS=, read -r -a list <<< "$cases"; takes+=("${list[@]}")
echo "calibration reel $SCENARIO ($CONFIG): ${takes[*]}"

# Another app run in this checkout's bundle dir: a mystral whose working
# directory it is, or this checkout's native-mac.sh.
busy() {
  local pid
  pgrep -f "$ROOT/scripts/native-mac.sh" >/dev/null && return 0
  for pid in $(pgrep -f "mystral run" || true); do
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qx "n$ROOT/client/dist-native" && return 0
  done
  return 1
}

take() {
  local id="$1" scene held
  # The scene the take loads: the case alone, or for the overview every case filmed.
  held="$id"; [ "$id" = overview ] && held="$cases"
  if [ "$id" = overview ] && [ -z "${CALIB_CASES:-}" ]; then scene="$DIR/scene.json"; held=""
  else scene="$ROOT/target/calib-film/$SCENARIO/$id.json"; node "$ROOT/structures/calibration/film/case-scene.mjs" "$DIR" "$held" "$scene" >&2; fi
  # client/dist-native is one bundle for every film from this checkout (film.js,
  # game.js, rebuilt when its inputs differ): no take while another app run
  # works in it (worktrees have their own), or the bundle lock is held.
  while [ -d "$ROOT/target/native-bundle.lock" ] || busy; do
    echo "take $id: waiting for another app run in $ROOT/client/dist-native" >&2; sleep 20
  done
  local out="$ROOT/target/calib-film/$SCENARIO/take-$id.out"
  CALIB_SCENE="$scene" FILM_DEFINES="--define:CALIB_SCENARIO=\"$SCENARIO\" --define:CALIB_CASE=\"$id\" --define:CALIB_CONFIG=\"$CONFIG\" --define:CALIB_FREEZE=$FREEZE --define:CALIB_SCENE_CASES=\"$held\" --define:CALIB_ONLY=\"$cases\"" \
    "$ROOT/scripts/native-mac.sh" film calibration --scene calib > "$out" 2>&1 || echo "take $id: native-mac.sh exited $? ($out); judged by the film's own log" >&2
  # The film's own verdict (native-mac.sh is shared and edited by others: bash
  # reading it mid-edit can fail after the film is done).
  local raw; raw=$(grep -oE '/[^ ]*/calibration-[0-9]+-[0-9]+\.mp4' "$out" | grep -v -- '-final\|-share' | head -1)
  [ -f "$raw" ] && grep -qE '\[film [0-9.]+s\] cut' "${raw%.mp4}.log" && ! grep -qE '\[film [0-9.]+s\] FAILED' "${raw%.mp4}.log" \
    || { echo "take $id FAILED ($out)" >&2; exit 1; }
  grep -E '\] calib \{' "${raw%.mp4}.log" | sed 's/.*\] calib /  /' >&2 || true
  node "$ROOT/structures/calibration/film/freeze.mjs" "$raw" "${raw%.mp4}.log" "${raw%.mp4}-take.mp4" --fps "$FILM_FPS" >&2
  echo "${raw%.mp4}-take.mp4"
}

parts=()
for id in "${takes[@]}"; do
  echo "take $id ..."
  parts+=("$(take "$id")")
  echo "  ${parts[${#parts[@]}-1]}"
done

out="$VIDEO/calibration-$SCENARIO-$(date +%Y%m%d-%H%M%S)"
inputs=() filter=""
for k in "${!parts[@]}"; do inputs+=(-i "${parts[$k]}"); filter+="[$k:v]setpts=PTS-STARTPTS[v$k];"; done
for k in "${!parts[@]}"; do filter+="[v$k]"; done
filter+="concat=n=${#parts[@]}:v=1:a=0,fps=$FILM_FPS[v]"
ffmpeg -v error -y "${inputs[@]}" -filter_complex "$filter" -map "[v]" \
  -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart "$out.mp4"
seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$out.mp4")
if [ "$(stat -f %z "$out.mp4")" -le 25000000 ]; then cp "$out.mp4" "$out-share.mp4"
else
  kbps=$(python3 -c "print(int(23.0 * 8000 / $seconds))")
  ffmpeg -v error -y -i "$out.mp4" -c:v libx264 -b:v "${kbps}k" -maxrate "${kbps}k" -bufsize "$((kbps * 2))k" -preset slow \
    -pix_fmt yuv420p -movflags +faststart "$out-share.mp4"
fi
ffmpeg -v error -y -i "$out.mp4" -vf "fps=10/$seconds,scale=384:-2,tile=5x2:padding=3:margin=3" -frames:v 1 -q:v 3 "$out-sheet.jpg"
echo "reel: $out.mp4 ($(python3 -c "print(round($seconds, 1))") s); share $out-share.mp4 ($(( $(stat -f %z "$out-share.mp4") / 1000000 )) MB); sheet $out-sheet.jpg"
