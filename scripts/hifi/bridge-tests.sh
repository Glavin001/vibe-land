#!/bin/bash
# Every bridge test binary (ignored included, benches excluded) in one profile.
#   scripts/hifi/bridge-tests.sh runtime|high
source "$(dirname "$0")/env.sh" "$1"
log=$HIFI_LOGS/bridge-$1.log; : > "$log"
cd "$HIFI_ROOT/physx-bridge"
cargo test --release -p vibe-land-physx-bridge --features native-destruction --no-run >> "$log.build" 2>&1 || { echo "build failed: $log.build"; exit 1; }
for exe in $(ls "$CARGO_TARGET_DIR/release/deps/" | grep -E '^[a-z_]+-[0-9a-f]{16}$'); do
  name=${exe%-*}
  case $name in gpu_step_bench|step_cost|gpu_load|vibe_land_physx_bridge|web_fps_server|vibe_*) continue ;; esac
  [ -x "$CARGO_TARGET_DIR/release/deps/$exe" ] || continue
  echo "=== $name" >> "$log"
  "$CARGO_TARGET_DIR/release/deps/$exe" --include-ignored --test-threads=1 >> "$log" 2>&1
  echo "=== $name EXIT $?" >> "$log"
done
echo "bridge $1: $(grep -c 'EXIT 0' "$log") binaries passed, $(grep -E '=== .* EXIT [1-9]' "$log" | sed 's/=== //' | tr '\n' ' ')"
