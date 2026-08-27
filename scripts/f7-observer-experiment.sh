#!/usr/bin/env bash
# F7: price the VIBE_PHYSX_PROFILE_FETCH busy-poll. File, not inline — inline
# wrappers self-match their own kill/wait patterns (three separate incidents).
# n=2 per arm, one binary, verdict via the equivalence-guarded tool.
set -uo pipefail
cd /root/workspace/vibe-land-4
export LD_LIBRARY_PATH="/root/PhysX/physx/install/linux-clang/PhysX/bin/linux.x86_64/release:${LD_LIBRARY_PATH:-}"
export BLAST_GPU_WHOLE_RESET_ON_TOPOLOGY=1 VIBE_CITY_FREEZE=1 VIBE_CITY_VARIED_HEIGHTS=0 \
  VIBE_CITY_SOLVER_ITERATIONS=32 VIBE_WORLD_FRICTION=0.75 VIBE_WORLD_RESTITUTION=0.02 \
  VIBE_CITY_STRESS_LIMIT_SCALE=0.45 VIBE_CITY_SHOT_BLAST_RADIUS=0.7 \
  VIBE_CITY_SHOT_STRESS_IMPULSE=4.0e7 VIBE_CITY_EXCESS_FORCES=1 VIBE_CITY_RESIM_PASSES=0

run() { # $1 label, $2 profile flag, $3 repeat tag
  env VIBE_PHYSX_PROFILE_FETCH="$2" ./target/release/record-city-trace \
    --scene destruction/assets/scenes/fractured-downtown.json \
    --grid 2 --seconds 60 --shots 15 --shot-interval-ticks 40 --targets 2 \
    --aim-lock --output /dev/null --label "$1" --packets-wire 3 \
    > "/tmp/f7c-$1-$3.log" 2>&1
}
run pfon3 1 a && run pfon3 1 b && run pfoff3 0 a && run pfoff3 0 b
echo "ARMS EXIT $?"
python3 -m scripts.perf.compare latest pfon3 pfoff3 -n 2
