#!/bin/bash
# The infinite_wall arms (physx-bridge/tests/infinite_wall.rs), impact solve
# off and on, one process each: scripts/impact/wall-arms.sh TEST_BINARY [arm ...]
# Run it under scripts/perf/gpu-run.sh. Extra environment passes through.
bin=$1; shift
for arm in "${@:-unbreakable grid one_plate}"; do
  for e in 0 1; do
    echo "== $arm impact $e"
    INFINITE_WALL_ARM=$arm VIBE_IMPACT_CAPACITY=$e PX_DESTRUCTION_ALLOW_UNCONVERGED=1 PX_DESTRUCTION_IMPACT_LOG=1 \
      "$bin" --exact arm --ignored --nocapture 2>&1 | grep -E 'tick [0-9]+ vz|v_end|v_min|v_regained|broken=|\[impact\] (pass|evaluation|  solve|  row)|panicked' | head -120
  done
done
