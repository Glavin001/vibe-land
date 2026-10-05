#!/usr/bin/env bash
# The native macOS app: three.js WebGPU on mystralnative (V8 + Dawn on Metal),
# with single-player /city running the city server's match loop in-process
# (sim-native, PhysX on CuMetal).
#
#   scripts/native-mac.sh build        # runtime + sim + bundle
#   scripts/native-mac.sh run [args]   # build, then run under the GPU lock
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

run() {
  cd "$BUNDLE_DIR"
  # The same environment the play server runs the city with
  # (scripts/perf/play-server.sh), under the machine's GPU lock.
  exec "$ROOT/scripts/perf/gpu-run.sh" native-city env \
    VIBE_PHYSICS_BACKEND=physx_gpu RUST_LOG="${RUST_LOG:-info}" \
    CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache" \
    VIBE_DESTRUCTION_ASSET_DIR="$ROOT/destruction/assets/scenes" \
    "$MYSTRAL" run game.js --title "vibe-land" --width 1600 --height 900 "$@"
}

case "${1:-run}" in
  runtime) runtime ;;
  sim) sim ;;
  bundle) bundle ;;
  build) runtime; sim; bundle ;;
  run) shift || true; runtime; sim; bundle; run "$@" ;;
  *) echo "usage: $0 [build|run|runtime|sim|bundle] [mystral run args]" >&2; exit 2 ;;
esac
