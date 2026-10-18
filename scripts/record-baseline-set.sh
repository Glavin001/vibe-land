#!/usr/bin/env bash
# The clean reference baseline on the new instrumentation: 3 identical
# grid-2 bombardment+settle runs, production env, PROFILE_FETCH per the F7
# decision (passed as $1, default 1 until decided). All future A/Bs compare
# against `latest baseline -n 3`.
set -uo pipefail
cd /root/workspace/vibe-land-4
export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
  VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0 \
  VIBE_PHYSX_PROFILE_FETCH="${1:-1}" VIBE_CITY_POSE_CENSUS=1
for repeat in a b c; do
  ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 200 --shots 40 --shot-interval-ticks 40 --targets 2 \
    --aim-lock --output /dev/null --label baseline --packets-wire 3 \
    > "/tmp/baseline-$repeat.log" 2>&1 || { echo "baseline $repeat FAILED"; exit 1; }
  echo "baseline $repeat done"
done
echo "BASELINE SET COMPLETE"
ls -t bench-results/runs | head -3
