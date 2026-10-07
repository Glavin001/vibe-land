#!/bin/bash
# PhysX destruction ctests of the combined build: rebuild the test tree, run everything.
#   scripts/hifi/ctest.sh [ctest args]
source "$(dirname "$0")/env.sh" runtime
log=$HIFI_LOGS/ctest-$(date +%H%M%S).log
(cd "$HIFI_PHYSX_TESTS" && make -k -j8 > "$log.build" 2>&1; ctest --output-on-failure --timeout 900 "$@") > "$log" 2>&1
echo "ctest: $(grep -E 'tests passed' "$log") ($log)"
