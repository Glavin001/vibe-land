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
#   scripts/native-mac.sh app           # build target/native-app/out/vibe-land.app
#   scripts/native-mac.sh runtime|sim|bundle
#
# MYSTRAL_ROOT: the mystralnative checkout (default ../mystralnative), built
# from its `vibe-land` integration branch. Extra `run` args go to `mystral run`
# (e.g. --headless --frames 1200 --screenshot out.png).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MYSTRAL_ROOT="${MYSTRAL_ROOT:-$(cd "$ROOT/.." && pwd)/mystralnative}"
SIM_TARGET="$ROOT/target/native-physx"
SIM_LIB="$SIM_TARGET/release/libvibe_sim.dylib"
BUNDLE_DIR="$ROOT/client/dist-native"
MYSTRAL="$MYSTRAL_ROOT/build/mystral"
PHYSX_LIB_DIR="${PHYSX_LIB_DIR:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/macos-cumetal/release/lib}"
APP_STAGE="$ROOT/target/native-app"

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
    CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" \
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
  (cd "$ROOT/client" && VIBE_SKIP_SCENE_PACKS=1 VIBE_SIM_LIB=libvibe_sim.dylib \
    npx vite build --mode native --outDir "$APP_STAGE/game")
  # mystral resolves file:// against the working directory, which the app's
  # launcher sets to Contents/Resources: these go at its root.
  local native_files=(vibe_land_shared_bg.wasm destruction_codec_bg.wasm city-packet-v3.dict)
  cp "$ROOT/client/src/wasm/pkg/vibe_land_shared_bg.wasm" \
     "$ROOT/client/src/wasm/debris-pkg/destruction_codec_bg.wasm" \
     "$ROOT/client/src/city/city-packet-v3.dict" \
     "$APP_STAGE/"
  # The city's scene (sim-native points VIBE_DESTRUCTION_ASSET_DIR here).
  cp "$ROOT/destruction/assets/scenes/${VIBE_CITY_SCENE:-high-rise-3f-local.json}" "$APP_STAGE/scenes/"
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

# A scripted playthrough (client/native/city-demo.js) recorded from the
# app's window with ScreenCaptureKit: real time, hardware H.264, in a visible
# window (macOS asks once for Screen Recording permission). RECORD_GPU=1
# records headless through GPU readback instead, paced to real time
# (--video-realtime); its WebP encoder is slow at high resolutions.
record() {
  local seconds="${1:-60}"; shift || true
  iife
  cp "$ROOT/client/native/city-demo.js" "$BUNDLE_DIR/"
  mkdir -p "$ROOT/target/native-video"
  local out="$ROOT/target/native-video/city-$(date +%Y%m%d-%H%M%S).mp4"
  local capture
  if [ "${RECORD_GPU:-0}" = 1 ]; then
    capture=(--headless --gpu-capture --video-realtime --video-fps 30 --end-frame $((30 * seconds)))
  else
    # Frames bound the length only; the window's loop runs at ~60 fps here.
    capture=(--native-capture --end-frame $((60 * seconds)))
  fi
  (launch city-demo.js --width 1600 --height 900 --video "$out" "${capture[@]}" "$@") 2>&1 \
    | tee "$ROOT/target/native-video/record.log" \
    | grep --line-buffered -E '\[demo|\[Video\] (Using|Recording|Captured [0-9]|Dropped|Recording complete)|FAILED|Error' || true
  [ -f "$out" ] || { echo "no video written (log: target/native-video/record.log)" >&2; exit 1; }
  echo "video: $out"
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
  *) echo "usage: $0 [build|run|runtime|sim|bundle] [mystral run args]" >&2; exit 2 ;;
esac
