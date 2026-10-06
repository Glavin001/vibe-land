#!/usr/bin/env bash
# The native macOS app: three.js WebGPU on mystralnative (V8 + Dawn on Metal),
# with single-player /city running the city server's match loop in-process
# (sim-native, PhysX on CuMetal).
#
#   scripts/native-mac.sh build        # runtime + sim + bundle
#   scripts/native-mac.sh run [args]   # build, then run under the GPU lock
#   scripts/native-mac.sh debug [args]  # run with module-evaluation errors printed
#   scripts/native-mac.sh smoke         # automated: load the city, shoot, expect fractures
#   scripts/native-mac.sh record [secs] # scripted playthrough recorded to target/native-video/*.mp4
#   scripts/native-mac.sh film NAME     # a film (client/native/film) to target/native-video/NAME-*
#   scripts/native-mac.sh qa [scenarios] # destruction QA: city-play-qa's checks + vehicle-qa's scenarios
#   scripts/native-mac.sh look          # camera poses saved to target/look/native/*.png
#   scripts/native-mac.sh perf          # frame and sim timings through heavy destruction
#   scripts/native-mac.sh app           # build target/native-app/out/vibe-land.app
#   scripts/native-mac.sh shots         # the scene from above and from the player, target/native-scene/
#   scripts/native-mac.sh structures    # does each structure of the scene converge at rest
#   scripts/native-mac.sh film-check    # film mode: exact ticks and clock per frame, then real time
#   scripts/native-mac.sh film-determinism # the same film twice from tick 0: what must match does
#   scripts/native-mac.sh runtime|sim|bundle
#
# --scene NAME (any subcommand) picks the city:
#   city            the default destructible city (high-rise-3f-local)
#   skyline         the buildings that stand on their own (skyline-stable:
#                   432 Park, the parking garage, Villa Savoye, two houses)
#   bayline         Bayline Town with Gardens & Market (structures/town-kit,
#                   as `npm run play:bayline-gardens` runs it on the web)
#   showcase        Bayline Heights (structures/showcase): the town, a
#                   ten-storey high-rise, houses east and on a hill, a jump
#                   kicker and six destructible cars -- every structure one
#                   that converges and stands at rest (scripts/perf/qualify_structures.py)
#   town            Vibe Town (structures/vibe-town): Elm Park's 42 houses with
#                   cars in the driveways, the Market Quarter's shops, towers,
#                   cinema, library, bus station and market square -- every
#                   structure qualified, everything above ground destructible
#
# MYSTRAL_ROOT: the mystralnative checkout (default ../mystralnative), built
# from its `vibe-land` integration branch. Extra `run` args go to `mystral run`
# (e.g. --headless --frames 1200 --screenshot out.png).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MYSTRAL_ROOT="${MYSTRAL_ROOT:-$(cd "$ROOT/.." && pwd)/mystralnative}"
# The PhysX SDK the sim links: the garage's (vehicle bump stops and drive
# masks, which the destructible city fleet needs), as
# scripts/perf/garage-vehicle-server.sh builds against.
export PHYSX_ROOT="${PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-multihull}"
SIM_TARGET="$ROOT/target/native-sim"
SIM_LIB="$SIM_TARGET/release/libvibe_sim.dylib"
BUNDLE_DIR="$ROOT/client/dist-native"
MYSTRAL="$MYSTRAL_ROOT/build/mystral"
PHYSX_LIB_DIR="${PHYSX_LIB_DIR:-$PHYSX_ROOT/lib}"
APP_STAGE="$ROOT/target/native-app"

# --scene NAME, anywhere in the arguments: the scene's server settings (read
# by the in-process city server, as by the real one) and the client's scene
# preset (read when the bundle is built).
SCENE=city
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = "--scene" ] && [ $# -gt 1 ]; then SCENE="$2"; shift 2; else args+=("$1"); shift; fi
done
set -- "${args[@]+"${args[@]}"}"
case "$SCENE" in
  city) ;;
  skyline)
    export VIBE_CITY_SCENE=skyline-stable.json VIBE_CITY_GRID=1 ;;
  bayline)
    # structures/town-kit/scripts/playground.mjs --gardens-market, the scene's
    # qualified settings (src/playground-config.mjs) and its heavy cannon --
    # plus the destructible car fleet the native app fields in every city,
    # parked around the town's edge (server/src/city_fleet.rs).
    town="$ROOT/structures/town-kit/out/bayline-town-with-gardens-and-market"
    [ -f "$town.json" ] && [ -f "$town.visuals.json" ] || {
      echo "Bayline Town is not built: (cd structures/town-kit && npm run build:bayline-gardens)" >&2; exit 1; }
    export VIBE_CITY_SCENE="$town.json" VIBE_CITY_VISUALS="$town.visuals.json" \
      VIBE_CITY_GRID=1 VIBE_CITY_VARIED_HEIGHTS=0 VIBE_CITY_DESTRUCTIBLE_VEHICLES="${VIBE_CITY_DESTRUCTIBLE_VEHICLES:-1}" \
      VIBE_CITY_FLEET_SLOTS="-56,2.5;56,-2.5;2.5,56;-2.5,-56;-66,-2.5" \
      VIBE_CITY_SPAWN_X=-45 VIBE_CITY_SPAWN_Z=0 \
      VIBE_CITY_BALL_MASS_KG=2000 VIBE_CITY_BALL_SPEED_MS=35 VIBE_CITY_BALL_TTL_TICKS=900 \
      VIBE_CITY_FREEZE=0 VIBE_CITY_NATIVE_SETTLE_TICKS=0 VIBE_CITY_NATIVE_SETTLE_FREEZE=0 \
      VIBE_CITY_NATIVE_STRESS_TOLERANCE=0.001 VIBE_CITY_NATIVE_STRESS_ITERATIONS=16 \
      VITE_TOWN_KIT_SCENE=bayline-town-with-gardens-and-market ;;
  showcase)
    town="$ROOT/structures/town-kit/out/bayline-town-with-gardens-and-market"
    pack="$ROOT/structures/showcase/out/vibe-showcase"
    [ -f "$town.json" ] || {
      echo "Bayline Town is not built: (cd structures/town-kit && npm run build:bayline-gardens)" >&2; exit 1; }
    # Rebuilt when stale or built with another SHOWCASE_EXCLUDE (parts left
    # out, to measure what each costs).
    [ -f "$pack.json" ] && [ "$pack.json" -nt "$ROOT/structures/showcase/build-showcase.mjs" ] \
      && [ "$pack.json" -nt "$town.json" ] \
      && [ "$(cat "$pack.exclude" 2>/dev/null || echo '?')" = "${SHOWCASE_EXCLUDE:-}" ] \
      || node "$ROOT/structures/showcase/build-showcase.mjs"
    # The default city's settling (rubble comes to rest), the cars at the
    # spawn line and the foot of each ramp, the spawn west of the kicker.
    # Stress iterations: Bayline was qualified at 16 and sheds ~1,600 bonds by
    # itself at the fleet's 64 (2026-10-05, scene shots); 16 here is an
    # owner-approved exception for this scene until Bayline requalifies at 64.
    # VIBE_CITY_NATIVE_STRESS_ITERATIONS overrides it.
    export VIBE_CITY_SCENE="$pack.json" VIBE_CITY_VISUALS="$pack.visuals.json" \
      VIBE_CITY_GRID=1 VIBE_CITY_VARIED_HEIGHTS=0 \
      VIBE_CITY_DESTRUCTIBLE_VEHICLES="${VIBE_CITY_DESTRUCTIBLE_VEHICLES:-monster,desert,derby,circuit,buggy,trophy}" \
      VIBE_CITY_FLEET_SLOTS="${VIBE_CITY_FLEET_SLOTS:--122,7;-122,-7;-112,7;-112,-7;110,40;-48,72}" \
      VIBE_CITY_SPAWN_X=-135 VIBE_CITY_SPAWN_Z=0 \
      VIBE_CITY_NATIVE_STRESS_ITERATIONS="${VIBE_CITY_NATIVE_STRESS_ITERATIONS:-16}" \
      VITE_TOWN_KIT_SCENE=vibe-showcase ;;
  town)
    pack="$ROOT/structures/vibe-town/out/vibe-town"
    stale=0
    for source in "$ROOT"/structures/vibe-town/*.mjs; do [ "$pack.json" -nt "$source" ] || stale=1; done
    [ -f "$pack.json" ] && [ "$stale" = 0 ] || node "$ROOT/structures/vibe-town/build-town.mjs"
    # Eleven cars: eight in Elm Park's driveways, two in the Market Quarter's
    # car park, a monster truck at North Street's west end for chases (the
    # builder's .slots, with headings). The spawn is Main Street's
    # west end. Stress iterations: 16, as every structure here was qualified
    # at (scripts/perf/qualify_structures.py) -- the showcase's owner-approved
    # exception; VIBE_CITY_NATIVE_STRESS_ITERATIONS overrides it.
    export VIBE_CITY_SCENE="$pack.json" VIBE_CITY_VISUALS="$pack.visuals.json" \
      VIBE_CITY_GRID=1 VIBE_CITY_VARIED_HEIGHTS=0 \
      VIBE_CITY_DESTRUCTIBLE_VEHICLES="${VIBE_CITY_DESTRUCTIBLE_VEHICLES:-derby,trophy,desert,circuit,derby,trophy,buggy,desert,monster,circuit,monster}" \
      VIBE_CITY_FLEET_SLOTS="${VIBE_CITY_FLEET_SLOTS:-$(cat "$pack.slots")}" \
      VIBE_CITY_SPAWN_X=-146 VIBE_CITY_SPAWN_Z=0 \
      VIBE_CITY_NATIVE_STRESS_ITERATIONS="${VIBE_CITY_NATIVE_STRESS_ITERATIONS:-16}" \
      VITE_TOWN_KIT_SCENE=vibe-town ;;
  *) echo "unknown --scene $SCENE (city, skyline, bayline, showcase, town)" >&2; exit 2 ;;
esac
[ "$SCENE" = city ] || echo "scene: $SCENE (${VIBE_CITY_SCENE})"

runtime() {
  [ -d "$MYSTRAL_ROOT" ] || { echo "no mystralnative checkout at $MYSTRAL_ROOT (set MYSTRAL_ROOT)" >&2; exit 1; }
  echo "mystralnative: $(git -C "$MYSTRAL_ROOT" rev-parse --abbrev-ref HEAD) $(git -C "$MYSTRAL_ROOT" rev-parse --short HEAD)"
  if [ ! -f "$MYSTRAL_ROOT/build/CMakeCache.txt" ]; then
    cmake -S "$MYSTRAL_ROOT" -B "$MYSTRAL_ROOT/build" -DCMAKE_BUILD_TYPE=Release \
      -DMYSTRAL_USE_V8=ON -DMYSTRAL_USE_DAWN=ON -DMYSTRAL_USE_QUICKJS=OFF -DMYSTRAL_USE_WGPU=OFF
  fi
  cmake --build "$MYSTRAL_ROOT/build" --parallel --target mystral
}

sim() {
  CARGO_TARGET_DIR="$SIM_TARGET" cargo build --release -p vibe-sim-native --features city \
    --manifest-path "$ROOT/Cargo.toml"
}

bundle() {
  (cd "$ROOT/client" && VIBE_SKIP_SCENE_PACKS=1 VIBE_SIM_LIB="$SIM_LIB" npx vite build --mode native)
  # Files the bundle reads through file:// (platform/nativeFiles.ts).
  cp "$ROOT/client/src/wasm/pkg/vibe_land_shared_bg.wasm" \
     "$ROOT/client/src/wasm/debris-pkg/destruction_codec_bg.wasm" \
     "$ROOT/client/src/city/city-packet-v3.dict" \
     "$BUNDLE_DIR/"
  echo "bundle: $BUNDLE_DIR/game.js (sim: $SIM_LIB)"
}

launch() {
  local entry="$1"; shift
  cd "$BUNDLE_DIR"
  # The same environment the play server runs the city with
  # (scripts/perf/play-server.sh), under the machine's GPU lock.
  exec "$ROOT/scripts/perf/gpu-run.sh" native-city env \
    VIBE_PHYSICS_BACKEND=physx_gpu RUST_LOG="${RUST_LOG:-info}" \
    CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-vehicles" \
    VIBE_DESTRUCTION_ASSET_DIR="$ROOT/destruction/assets/scenes" \
    "$MYSTRAL" run "$entry" --title "vibe-land" --width 1600 --height 900 "$@"
}

run() { launch game.js "$@"; }

iife() {
  "$ROOT/client/node_modules/.bin/esbuild" "$BUNDLE_DIR/game.js" --format=iife \
    --outfile="$BUNDLE_DIR/game-iife.js" --log-level=warning
}

debug() {
  iife
  cp "$ROOT/client/native/debug-entry.js" "$BUNDLE_DIR/"
  launch debug-entry.js "$@"
}

smoke() {
  iife
  cp "$ROOT/client/native/city-smoke.js" "$BUNDLE_DIR/"
  # Judged by the test's own verdict line: mystral can exit 137 at shutdown
  # on macOS (its audio teardown) whatever the script asked for.
  local log="$ROOT/target/native-smoke.log"
  (launch city-smoke.js --headless "$@") 2>&1 | tee "$log" | grep --line-buffered '\[smoke\]' || true
  grep -q '\[smoke\] PASS' "$log" || { echo "native smoke FAILED (log: $log)" >&2; exit 1; }
  echo "native smoke passed (log: $log)"
}

# Copy a dylib into the app's Frameworks staging dir with nothing pointing
# outside the app: Homebrew dependencies are copied too and loaded via @rpath,
# and absolute rpaths (the build machine's PhysX install) are removed.
stage_dylib() {
  local src="$1" dest_dir="$2"
  local name; name="$(basename "$src")"
  local dest="$dest_dir/$name"
  [ -f "$dest" ] && return 0
  cp "$src" "$dest"; chmod u+w "$dest"
  install_name_tool -id "@rpath/$name" "$dest" 2>/dev/null
  local dep
  for dep in $(otool -L "$dest" | tail -n +2 | awk '{print $1}' | grep -E '^/(opt|usr/local)/' || true); do
    stage_dylib "$dep" "$dest_dir"
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$dest" 2>/dev/null
  done
  local rpath
  for rpath in $(otool -l "$dest" | awk '/LC_RPATH/{getline; getline; print $2}' | grep '^/' || true); do
    install_name_tool -delete_rpath "$rpath" "$dest" 2>/dev/null
  done
}

app() {
  rm -rf "$APP_STAGE"
  mkdir -p "$APP_STAGE/game" "$APP_STAGE/scenes" "$APP_STAGE/frameworks"
  # A bundle that loads libvibe_sim by name, from Contents/Frameworks.
  (cd "$ROOT/client" && VIBE_SKIP_SCENE_PACKS=1 VIBE_SIM_LIB=libvibe_sim.dylib VIBE_NATIVE_ASSET_ROOT=game/ \
    npx vite build --mode native --outDir "$APP_STAGE/game")
  # mystral resolves file:// against the working directory, which the app's
  # launcher sets to Contents/Resources: these go at its root.
  local native_files=(vibe_land_shared_bg.wasm destruction_codec_bg.wasm city-packet-v3.dict)
  cp "$ROOT/client/src/wasm/pkg/vibe_land_shared_bg.wasm" \
     "$ROOT/client/src/wasm/debris-pkg/destruction_codec_bg.wasm" \
     "$ROOT/client/src/city/city-packet-v3.dict" \
     "$APP_STAGE/"
  # The city's scene (sim-native points VIBE_DESTRUCTION_ASSET_DIR here).
  local scene="${VIBE_CITY_SCENE:-high-rise-3f-local.json}"
  case "$scene" in /*) ;; *) scene="$ROOT/destruction/assets/scenes/$scene" ;; esac
  cp "$scene" "$APP_STAGE/scenes/"
  # The sim and its GPU stack, self-contained.
  stage_dylib "$SIM_LIB" "$APP_STAGE/frameworks"
  for lib in "$PHYSX_LIB_DIR"/*.dylib; do stage_dylib "$lib" "$APP_STAGE/frameworks"; done
  # CuMetal's prebuilt pipelines: data, so Resources (signing allows only
  # code in Frameworks); sim-native points CUMETAL_PIPELINE_ARCHIVE_PATH here.
  cp -R "$PHYSX_LIB_DIR/cumetal-pipeline-archive" "$APP_STAGE/"
  local frameworks=()
  for item in "$APP_STAGE/frameworks"/*; do frameworks+=(--frameworks "$item"); done
  local resources=(--resources game --resources scenes --resources cumetal-pipeline-archive)
  for item in "${native_files[@]}"; do resources+=(--resources "$item"); done
  (cd "$APP_STAGE" && bash "$MYSTRAL_ROOT/scripts/package-app.sh" \
    --binary "$MYSTRAL" --name "vibe-land" --bundle-id land.vibe.native \
    --script game/game.js "${resources[@]}" \
    "${frameworks[@]}" --output "$APP_STAGE/out")
  echo "app: $APP_STAGE/out/vibe-land.app"
}

# Destruction QA in the app (client/native/city-qa.mjs): city-play-qa's walk
# and meteor checks and vehicle-qa's scenarios, through vehicle-qa's own
# engine. QA scenarios: a comma list (city-play, cannonball-wreck, ...);
# empty runs them all. Judged by the runner's verdict line.
qa() {
  local wanted="${1:-}"; shift || true
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/city-qa.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning \
    --define:QA_SCENARIOS="\"$wanted\"" --outfile="$BUNDLE_DIR/city-qa.js"
  local log="$ROOT/target/native-qa.log"
  (launch city-qa.js --headless "$@") 2>&1 | tee "$log" | grep --line-buffered '\[qa' || true
  grep -q '\[qa\] VERDICT PASS' "$log" || { echo "native QA FAILED (log: $log)" >&2; exit 1; }
  echo "native QA passed (log: $log)"
}

# Real keyboard and mouse input (client/native/input-check.mjs): events
# injected through mystral's own dispatcher, not the scripted drive bridge.
input() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/input-check.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --outfile="$BUNDLE_DIR/input-check.js"
  local log="$ROOT/target/native-input.log"
  (launch input-check.js "$@") 2>&1 | tee "$log" | grep --line-buffered '\[input' || true
  grep -q '\[input\] VERDICT PASS' "$log" || { echo "native input check FAILED (log: $log)" >&2; exit 1; }
  echo "native input check passed (log: $log)"
}

# Cars drive on every surface (client/native/drive-check.mjs): one car each on
# open ground, Bayline's road paving and up the jump kicker (--scene showcase).
drive() {
  [ "$SCENE" = showcase ] || { echo "drive needs --scene showcase" >&2; exit 2; }
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/drive-check.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --outfile="$BUNDLE_DIR/drive-check.js"
  local log="$ROOT/target/native-drive.log"
  (launch drive-check.js "$@") 2>&1 | tee "$log" | grep --line-buffered '\[drive' || true
  grep -q '\[drive\] VERDICT PASS' "$log" || { echo "native drive check FAILED (log: $log)" >&2; exit 1; }
  echo "native drive check passed (log: $log)"
}

# Film mode (client/native/film-check.mjs): frame-locked offline rendering --
# exact sim ticks and clock steps per film frame, and real time after.
film_check() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/film-check.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --outfile="$BUNDLE_DIR/film-check.js"
  local log="$ROOT/target/native-film-check.log"
  (launch film-check.js --headless "$@") 2>&1 | tee "$log" | grep --line-buffered -E '\[film|Shutting down|Caught signal' || true
  grep -q '\[film-check\] VERDICT PASS' "$log" || { echo "native film check FAILED (log: $log)" >&2; exit 1; }
  echo "native film check passed (log: $log)"
}

# Re-renderable films (client/native/film-determinism.mjs): one fixed film
# taken twice with the match in lockstep from tick 0 (VIBE_FILM_LOCKSTEP=1)
# and the same seeds, compared by scripts/native-film-determinism.py: tick
# schedule, inputs applied per tick and Math.random draws must match; the
# broken bonds after the volley are reported (GPU PhysX is not bit-exact).
#   FILM_DET_SEED     the film's Math.random seed (default 7)
#   VIBE_MATCH_SEED   the match seed (default 424242)
film_determinism() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/film-determinism.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --define:FILM_DET_SEED="${FILM_DET_SEED:-7}" \
    --outfile="$BUNDLE_DIR/film-determinism.js"
  export VIBE_FILM_LOCKSTEP=1 VIBE_MATCH_SEED="${VIBE_MATCH_SEED:-424242}"
  local take
  for take in 1 2; do
    echo "take $take"
    (launch film-determinism.js --headless "$@") > "$ROOT/target/native-film-det-$take.log" 2>&1 || true
    grep -E '\[film-det\] (PASS|FAIL|load|bonds|VERDICT)' "$ROOT/target/native-film-det-$take.log" || true
  done
  python3 "$ROOT/scripts/native-film-determinism.py" "$ROOT/target/native-film-det-1.log" "$ROOT/target/native-film-det-2.log"
}

# Does each structure of the scene converge at rest (scripts/perf/qualify_structures.py)?
# A structure that does not keeps the GPU re-solving it every idle tick.
structures() {
  local pack="${VIBE_CITY_SCENE:-high-rise-3f-local.json}"
  python3 "$ROOT/scripts/perf/qualify_structures.py" "$pack" "$@"
}

# The scene from above and from the player (client/native/scene-shot.mjs).
shots() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/scene-shot.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning \
    --define:SCENE_NAME="\"$SCENE\"" --outfile="$BUNDLE_DIR/scene-shot.js"
  mkdir -p "$ROOT/target/native-scene"
  (launch scene-shot.js "$@") 2>&1 | tee "$ROOT/target/native-scene/$SCENE.log" | grep --line-buffered '\[scene' || true
}

# Which buffers Dawn rejects as unaligned writes (client/native/writebuffer-trace.mjs).
trace_writes() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/writebuffer-trace.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --outfile="$BUNDLE_DIR/writebuffer-trace.js"
  (launch writebuffer-trace.js --headless "$@") 2>&1 | tee "$ROOT/target/native-writes.log" | grep --line-buffered '\[trace' || true
}

# The native side of the look comparison: the e2e/helpers/lookPoses.mjs
# camera poses, saved to target/look/native/<pose>.png (the web side is
# client/e2e/look-capture.mjs; client/e2e/look-sheet.mjs lays them out).
look() {
  iife
  local out="$ROOT/target/look/native"
  mkdir -p "$out"
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/look-capture.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning \
    --define:LOOK_OUT="\"$out\"" --outfile="$BUNDLE_DIR/look-capture.js"
  (launch look-capture.js --headless "$@") 2>&1 | tee "$ROOT/target/look/native.log" | grep --line-buffered '\[look' || true
}

# Performance through heavy destruction (client/native/perf-capture.mjs):
# per-phase render frame times and sim tick rate/time, in a visible window so
# frames are paced by the display as when playing. Extra args go to mystral.
perf() {
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/perf-capture.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --define:PERF_PROFILE="\"${PERF_PROFILE:-}\"" \
    --outfile="$BUNDLE_DIR/perf-capture.js"
  mkdir -p "$ROOT/target/native-perf"
  (launch perf-capture.js "$@") 2>&1 | tee "$ROOT/target/native-perf/perf.log" | grep --line-buffered '\[perf' || true
}

# A scripted playthrough (client/native/city-demo.mjs) recorded from the
# app's window with ScreenCaptureKit: real time, hardware H.264, in a visible
# window (macOS asks once for Screen Recording permission). RECORD_GPU=1
# records headless through GPU readback instead, paced to real time
# (--video-realtime); its WebP encoder is slow at high resolutions.
# RECORD_SCRIPT picks another script in client/native; one that logs
# `[<tag> ...] rolling` and `... cut` is trimmed to that span, as
# target/native-video/<script>-...-cut.mp4. Films (elm-park-tour) have their
# own command, `film`, below.
record() {
  local seconds="${1:-120}"; shift || true
  local script="${RECORD_SCRIPT:-city-demo}"
  iife
  "$ROOT/client/node_modules/.bin/esbuild" "$ROOT/client/native/$script.mjs" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning --outfile="$BUNDLE_DIR/$script.js"
  mkdir -p "$ROOT/target/native-video"
  local out="$ROOT/target/native-video/${script/city-demo/city}-$(date +%Y%m%d-%H%M%S).mp4"
  local capture
  if [ "${RECORD_GPU:-0}" = 1 ]; then
    # 1280x720: the WebP encoder keeps up with 30 fps there (it does not at 1600x900).
    capture=(--headless --gpu-capture --video-realtime --video-fps 30 --end-frame $((30 * seconds)) --width 1280 --height 720)
  else
    # Frames bound the length only; the window's loop runs at ~60 fps here.
    capture=(--native-capture --end-frame $((60 * seconds)))
  fi
  (launch "$script.js" --width 1600 --height 900 --video "$out" "${capture[@]}" "$@") 2>&1 \
    | tee "$ROOT/target/native-video/record.log" \
    | grep --line-buffered -E '\[demo|\[tour|\[film|\[Video\] (Using|Recording|Captured [0-9]|Dropped|Recording complete)|FAILED|Error' || true
  [ -f "$out" ] || { echo "no video written (log: target/native-video/record.log)" >&2; exit 1; }
  echo "video: $out"
  # Trim to the script's own span. Its log times count from its own start,
  # which is the window's first frame, give or take a second; a script holds
  # its opening shot a moment before `rolling`, so the cut starts 1.5 s early.
  local from to
  from=$(grep -oE '\[[a-z]+ [0-9.]+s\] rolling' "$ROOT/target/native-video/record.log" | grep -oE '[0-9]+\.[0-9]+' | head -1)
  to=$(grep -oE '\[[a-z]+ [0-9.]+s\] cut' "$ROOT/target/native-video/record.log" | grep -oE '[0-9]+\.[0-9]+' | head -1)
  if [ -n "$from" ] && [ -n "$to" ] && command -v ffmpeg >/dev/null; then
    ffmpeg -v error -y -ss "$(python3 -c "print(max(0.0, $from - 1.5))")" -i "$out" -t "$(python3 -c "print($to - $from + 2.0)")" \
      -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart "${out%.mp4}-cut.mp4" \
      && echo "cut: ${out%.mp4}-cut.mp4"
  fi
}

# Films (client/native/film): `film NAME` plays client/native/films/NAME.mjs
# (or client/native/NAME.mjs) headless; the film records itself through
# mystral's recorder (__mystralRecordStart), from its first shot to its cut,
# on film time (the sim in lockstep with frames, __VIBE_FILM__) when the app
# has film mode. Without the recorder it saves each film frame as a PNG
# (slower), or without film mode too, the whole run is recorded in real time
# through --video and trimmed to the film's `rolling` .. `cut`.
#   FILM_FPS      30 (default) or 60
#   FILM_SIZE     WxH, default 1280x720 (640x360 for a preview)
#   FILM_PREVIEW=1  no video: a still from the middle of each shot, and a sheet of them
#   FILM_POSTER   the poster frame's time in seconds (default 40% in)
#   FILM_REBUILD=1  rebuild the bundle even when its inputs are unchanged
#   FILM_CUT_FPS  the final cut's frame rate (default 30)
# Writes target/native-video/NAME-<stamp>.mp4, -share.mp4 (under 25 MB),
# -sheet.jpg (ten frames), -poster.jpg and .log; a preview, NAME-<stamp>-preview/
# and -preview.jpg. When the log holds an edit list (`edit {json}` lines from
# the film's cues: titles, cards, slow motion, flashes, fades, letterbox),
# scripts/film/post.py cuts the recording to NAME-<stamp>-final.mp4 and the
# share copy, sheet and poster come from that; the raw .mp4 stays. By hand:
#   python3 scripts/film/post.py VIDEO LOG [--out FINAL] [--fps 30] [--verbose]
film() {
  local name="${1:-}"; shift || true
  [ -n "$name" ] || { echo "usage: $0 film NAME [--scene S] [mystral args]" >&2; exit 2; }
  local script="$ROOT/client/native/films/$name.mjs"
  [ -f "$script" ] || script="$ROOT/client/native/$name.mjs"
  [ -f "$script" ] || { echo "no film $name (client/native/films/$name.mjs or client/native/$name.mjs)" >&2; exit 2; }
  local fps="${FILM_FPS:-30}" preview="${FILM_PREVIEW:-0}" check="${FILM_CHECK:-0}"
  case "$fps" in 30|60) ;; *) echo "FILM_FPS is 30 or 60" >&2; exit 2 ;; esac
  local size="${FILM_SIZE:-$([ "$preview" = 1 ] || [ "$check" = 1 ] && echo 640x360 || echo 1280x720)}"
  local base; base="$ROOT/target/native-video/$name-$(date +%Y%m%d-%H%M%S)"
  local out="$base.mp4" log="$base.log"
  mkdir -p "$ROOT/target/native-video"
  # Film-only simulation settings. Meteors launched a fixed 384 m away (300 m
  # out, 240 m up) at 140 m/s land METEOR_FLIGHT_S = 2.74 s later
  # (client/native/film/shots.mjs strike), and a pool of 64 keeps a barrage's
  # rocks in the air. Quality before speed: a film frame takes as long as the
  # sim needs, so the stress solve gets its full 64 iterations
  # (FILM_STRESS_ITERATIONS overrides; the town plays at 16).
  export VIBE_CITY_METEOR_RANGE_MIN_M=300 VIBE_CITY_METEOR_RANGE_MAX_M=300 \
    VIBE_CITY_METEOR_HEIGHT_MIN_M=240 VIBE_CITY_METEOR_HEIGHT_MAX_M=240 \
    VIBE_METEOR_POOL="${VIBE_METEOR_POOL:-64}" \
    VIBE_CITY_NATIVE_STRESS_ITERATIONS="${FILM_STRESS_ITERATIONS:-64}"
  # Re-renderable: the sim born in lockstep at tick 0 (only film frames move
  # it), and one seed (FILM_SEED, default 1) for the server's meteor bearings
  # and the client's Math.random. Takes then differ only by GPU physics.
  # Previews pose the camera without film mode, so they run in real time.
  local seed="${FILM_SEED:-1}" lockstep=false
  if [ "$preview" != 1 ]; then export VIBE_FILM_LOCKSTEP=1; lockstep=true; fi
  export VIBE_MATCH_SEED="$seed"
  [ "$BUNDLE_DIR/game-iife.js" -nt "$BUNDLE_DIR/game.js" ] || iife
  # Without mystral's recorder: in film mode, every film frame as a PNG
  # (slow, exact); without film mode, the whole run in real time through
  # --video, trimmed to the film.
  local capture=(--headless --width "${size%x*}" --height "${size#*x}") raw="" sequence=false
  if [ "$preview" = 1 ]; then
    mkdir -p "$base-preview"
  elif [ "$check" = 1 ]; then
    mkdir -p "$base-check"
  elif ! grep -qa __mystralRecordStart "$MYSTRAL"; then
    if grep -q __VIBE_FILM__ "$BUNDLE_DIR/game.js"; then
      sequence=true; mkdir -p "$base-frames"
      echo "film: mystral has no __mystralRecordStart; saving every frame to $base-frames/"
    else
      raw="$base-raw.mp4"
      capture+=(--gpu-capture --video-realtime --video-fps "$fps" --end-frame $((fps * 3600)) --video "$raw")
      echo "film: no __mystralRecordStart and no film mode; recording the run in real time, trimmed to the film"
    fi
  fi
  "$ROOT/client/node_modules/.bin/esbuild" "$script" --bundle --format=esm \
    --platform=browser --target=es2022 --log-level=warning \
    --define:FILM_OUT="\"$out\"" --define:FILM_FPS="$fps" --define:FILM_SCENE="\"$SCENE\"" \
    --define:FILM_PREVIEW="$([ "$preview" = 1 ] && echo true || echo false)" --define:FILM_SEQUENCE="$sequence" \
    --define:FILM_LOCKSTEP="$lockstep" --define:FILM_SEED="$seed" \
    --define:FILM_CHECK="$([ "$check" = 1 ] && echo true || echo false)" --define:FILM_SHOTS="\"${FILM_SHOTS:-}\"" \
    --outfile="$BUNDLE_DIR/film.js"
  (launch film.js "${capture[@]}" "$@") 2>&1 | tee "$log" \
    | grep --line-buffered -E '\[film|\[Video\] (Using|Recording|Dropped|Recording complete)|FAILED|Error' \
    | grep --line-buffered -vE '\] (stats|impact|truck) \{' || true
  grep -qE '\[film [0-9.]+s\] cut' "$log" && ! grep -qE '\[film [0-9.]+s\] FAILED' "$log" \
    || { echo "film FAILED (log: $log)" >&2; exit 1; }
  # Per-frame performance (frame/step/render/physx ms, active bodies, damage)
  # from the log's stats lines: $base-stats.csv, .json and .html.
  [ "$preview" = 1 ] || python3 "$ROOT/scripts/film/stats.py" "$log" || echo "film: stats FAILED (log: $log)" >&2
  command -v ffmpeg >/dev/null || { echo "film: no ffmpeg, so no sheet, poster or share copy" >&2; return 0; }
  if [ "$check" = 1 ]; then
    local stills=("$base-check"/*.png)
    [ -e "${stills[0]}" ] || { echo "film: check saved no stills (log: $log)" >&2; exit 1; }
    ffmpeg -v error -y -pattern_type glob -i "$base-check/*.png" \
      -vf "scale=320:-2,tile=6x$(( (${#stills[@]} + 5) / 6 )):padding=3:margin=3" -frames:v 1 -q:v 3 "$base-check.jpg"
    echo "check: ${#stills[@]} stills (2 a second) in $base-check/, sheet $base-check.jpg; stats $base-stats.html"
    return 0
  fi
  if [ "$preview" = 1 ]; then
    local stills=("$base-preview"/*.png)
    ffmpeg -v error -y -pattern_type glob -i "$base-preview/*.png" \
      -vf "scale=480:-2,tile=4x$(( (${#stills[@]} + 3) / 4 )):padding=4:margin=4" -frames:v 1 -q:v 3 "$base-preview.jpg"
    echo "preview: ${#stills[@]} stills in $base-preview/, sheet $base-preview.jpg"
    return 0
  fi
  if [ "$sequence" = true ]; then
    ffmpeg -v error -y -framerate "$fps" -i "$base-frames/%05d.png" \
      -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart "$out" && rm -rf "$base-frames"
  elif [ -n "$raw" ]; then
    # The log's times count from the script's start, the video's first frame
    # give or take a moment: a little either side of the film, which holds
    # its first pose before rolling and its last after the cut.
    local from to
    from=$(grep -oE '\[film [0-9.]+s\] rolling' "$log" | grep -oE '[0-9]+\.[0-9]+' | head -1)
    to=$(grep -oE '\[film [0-9.]+s\] cut' "$log" | grep -oE '[0-9]+\.[0-9]+' | head -1)
    [ -f "$raw" ] && [ -n "$from" ] && [ -n "$to" ] || { echo "film: no video to trim (log: $log)" >&2; exit 1; }
    ffmpeg -v error -y -ss "$(python3 -c "print(max(0.0, $from - 0.5))")" -i "$raw" -t "$(python3 -c "print($to - $from + 0.8)")" \
      -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -movflags +faststart "$out" && rm -f "$raw"
  fi
  [ -f "$out" ] || { echo "film: no video written (log: $log)" >&2; exit 1; }
  # Post-production: the edit list, if the film logged one, cut to -final.mp4.
  local cut="$out"
  if grep -qE '(^|[] ])edit \{' "$log"; then
    python3 "$ROOT/scripts/film/post.py" "$out" "$log" --out "$base-final.mp4" --fps "${FILM_CUT_FPS:-30}" \
      || { echo "film: post-production FAILED (log: $log)" >&2; exit 1; }
    cut="$base-final.mp4"
  fi
  local seconds; seconds=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$cut")
  # Under 25 MB to share: as it is when it fits, else re-encoded to fit.
  local limit=25000000 kbps
  if [ "$(stat -f %z "$cut")" -le "$limit" ]; then
    cp "$cut" "$base-share.mp4"
  else
    kbps=$(python3 -c "print(int(23.0 * 8000 / $seconds))")
    for _ in 1 2 3; do
      ffmpeg -v error -y -i "$cut" -c:v libx264 -preset slow -b:v "${kbps}k" -maxrate "$((kbps * 3 / 2))k" \
        -bufsize "$((kbps * 2))k" -pix_fmt yuv420p -movflags +faststart -an "$base-share.mp4"
      [ "$(stat -f %z "$base-share.mp4")" -le "$limit" ] && break
      kbps=$((kbps * 4 / 5))
    done
  fi
  ffmpeg -v error -y -i "$cut" -vf "fps=10/$seconds,scale=384:-2,tile=5x2:padding=4:margin=4" -frames:v 1 -q:v 3 "$base-sheet.jpg"
  ffmpeg -v error -y -ss "${FILM_POSTER:-$(python3 -c "print($seconds * 0.4)")}" -i "$cut" -frames:v 1 -q:v 2 "$base-poster.jpg"
  [ "$cut" = "$out" ] || echo "film: raw recording $out"
  echo "film: $cut ($(python3 -c "print(round($seconds, 1))") s); share $base-share.mp4 ($(( $(stat -f %z "$base-share.mp4") / 1000000 )) MB), sheet $base-sheet.jpg, poster $base-poster.jpg"
}

# The bundle, unless nothing it is built from changed since the last film
# built it: client sources and config, the files outside client/ they import,
# the env files and VITE_/VIBE_ variables. Any other build of the bundle
# empties client/dist-native, stamp included, so it never vouches for one.
film_inputs() {
  (cd "$ROOT" && find client/src client/public client/index.html client/vite.config.ts client/tsconfig.json \
      client/package.json client/package-lock.json client/node_modules/.package-lock.json \
      shared/match-stats-frame.json shared/fixtures worlds structures/town-kit/vendor .env .env.* \
      -type f -print0 2>/dev/null | xargs -0 stat -f '%m %z %N' | LC_ALL=C sort)
  env | grep -E '^(VITE|VIBE)_' | LC_ALL=C sort || true
  echo "$SIM_LIB"
}
film_bundle() {
  local stamp="$BUNDLE_DIR/.film-bundle-inputs"
  if [ "${FILM_REBUILD:-0}" != 1 ] && [ -f "$BUNDLE_DIR/game.js" ] && [ -f "$stamp" ] && film_inputs | cmp -s - "$stamp"; then
    echo "bundle: unchanged ($BUNDLE_DIR/game.js)"
  else
    bundle
    film_inputs > "$stamp"
  fi
}

case "${1:-run}" in
  runtime) runtime ;;
  sim) sim ;;
  bundle) bundle ;;
  build) runtime; sim; bundle ;;
  run) shift || true; runtime; sim; bundle; run "$@" ;;
  debug) shift || true; debug "$@" ;;
  smoke) shift || true; runtime; sim; bundle; smoke "$@" ;;
  app) runtime; sim; app ;;
  record) shift || true; runtime; sim; bundle; record "$@" ;;
  film) shift || true; runtime; sim; film_bundle; film "$@" ;;
  qa) shift || true; runtime; sim; bundle; qa "$@" ;;
  input) shift || true; runtime; sim; bundle; input "$@" ;;
  film-check) shift || true; runtime; sim; bundle; film_check "$@" ;;
  film-determinism) shift || true; runtime; sim; bundle; film_determinism "$@" ;;
  trace-writes) shift || true; runtime; sim; bundle; trace_writes "$@" ;;
  shots) shift || true; runtime; sim; bundle; shots "$@" ;;
  structures) shift || true; structures "$@" ;;
  drive) shift || true
    # One car per surface, in drive-check.mjs's SURFACES order.
    export VIBE_CITY_DESTRUCTIBLE_VEHICLES=monster,desert,derby \
      VIBE_CITY_FLEET_SLOTS="-112,7;-30,-2.5;-104,0"
    runtime; sim; bundle; drive "$@" ;;
  look) shift || true; runtime; sim; bundle; look "$@" ;;
  perf) shift || true; runtime; sim; bundle; perf "$@" ;;
  # perf with a V8 CPU profile of each phase, on an unminified bundle:
  # target/native-perf/<phase>.cpuprofile, summarised by
  # scripts/perf/cpuprofile-summary.mjs (or open one in Chrome DevTools).
  profile) shift || true; runtime; sim; VIBE_NATIVE_PROFILE=1 bundle; PERF_PROFILE=1 perf "$@"
    for f in "$ROOT"/target/native-perf/*.cpuprofile; do node "$ROOT/scripts/perf/cpuprofile-summary.mjs" "$f"; done ;;
  *) echo "usage: $0 [build|run|runtime|sim|bundle] [mystral run args]" >&2; exit 2 ;;
esac
