#!/bin/bash
# The impact study's exported first ticks through destruction_impact_replay:
#   scripts/impact/replays.sh REPLAY_BINARY DIR [scenario ...]   (under gpu-run.sh)
bin=$1;dir=$2;shift 2
for sc in "${@:-meteor truck truck-corner cannonball}"; do
  printf '%s: ' "$sc"; CUMETAL_USE_METAL_DEVICE_ADDRESSES=1 "$bin" "$dir/$sc.impe" "$dir/$sc.gpu" 2>&1 | grep -v WARNING | tail -1
done
