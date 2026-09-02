#!/bin/bash
export LD_LIBRARY_PATH=/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:$LD_LIBRARY_PATH
cd /root/workspace/vibe-land-2
run() {
  local label="$1"; shift
  rm -rf /tmp/ramp-$label && mkdir -p /tmp/ramp-$label
  echo "===== $label ====="
  env "$@" ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 1 --hz 60 --seconds 300 --settle-ticks 30 \
    --shots 2000 --shot-interval-ticks 8 --shot-ramp-min-ticks 3 \
    --packets-out /tmp/ramp-$label --output /dev/null 2>&1 | tail -6
}
run off VIBE_CITY_FREEZE=0
run on  VIBE_CITY_FREEZE=1 VIBE_CITY_FREEZE_POSE=1
echo "ALL_DONE"
