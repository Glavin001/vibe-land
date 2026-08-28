#!/bin/bash
export LD_LIBRARY_PATH=/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:$LD_LIBRARY_PATH
cd /root/workspace/vibe-land-2
for cfg in "off:VIBE_CITY_FREEZE=0" "on:VIBE_CITY_FREEZE=1"; do
  label="${cfg%%:*}"; envs="${cfg#*:}"
  rm -rf /tmp/fl-$label && mkdir -p /tmp/fl-$label
  env $envs VIBE_CITY_POSE_CENSUS=1 ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-highrise-10f.json \
    --grid 1 --hz 60 --seconds 70 --settle-ticks 30 \
    --shots 60 --shot-interval-ticks 40 \
    --packets-out /tmp/fl-$label --output /dev/null > /dev/null 2>&1
done
echo FLOAT_AB_DONE
