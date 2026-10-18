#!/bin/bash
export LD_LIBRARY_PATH=/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:$LD_LIBRARY_PATH
cd /root/workspace/vibe-land-2
rec() {
  local label="$1"; shift
  echo "===== $label ====="
  env "$@" ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-highrise-10f.json \
    --grid 1 --hz 60 --seconds 45 --settle-ticks 30 \
    --shots 26 --shot-interval-ticks 90 \
    --output /tmp/vv-$label.towertrace 2>&1 | tail -5
  ls -lh /tmp/vv-$label.towertrace
}
rec froff VIBE_CITY_FREEZE=0
rec fron  VIBE_CITY_FREEZE=1 VIBE_CITY_FREEZE_POSE=1
echo REC_DONE
df -h / | tail -1
