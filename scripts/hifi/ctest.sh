#!/bin/bash
# PhysX destruction ctests of the combined build: rebuild the test tree, run everything.
#   scripts/hifi/ctest.sh [ctest args]
source "$(dirname "$0")/env.sh" runtime; unset PX_DESTRUCTION_ALLOW_UNCONVERGED  # strict tests pin it themselves
log=$HIFI_LOGS/ctest-$(date +%H%M%S).log
(cd "$HIFI_PHYSX_TESTS" && cmake --build . --target all destruction_test_executables -j 8 > "$log.build" 2>&1; "$GPU_RUN" hifi-ctest ctest --output-on-failure --timeout 900 "$@") > "$log" 2>&1
echo "ctest: $(grep -E 'tests passed' "$log") ($log)"
