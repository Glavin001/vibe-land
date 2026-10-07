# Rebuild garage-hifi at PhysX integration/high-fidelity HEAD, the high packs, the destruction gate.
set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
(cd /Users/glavin/Development/vibe-land && PHYSX_SRC=/Users/glavin/Development/PhysX/.claude/worktrees/hifi GARAGE_SDK_NAME=garage-hifi scripts/perf/rebuild-garage-sdk.sh) > target/hifi-logs/sdk-9.log 2>&1 || { echo "sdk failed"; exit 1; }
tail -1 target/hifi-logs/sdk-9.log
export TOWN_KIT_AUTHORING_ROOT=/Users/glavin/Development/PhysX/.claude/worktrees/hifi/blast/blast-stress-solver/structures
scripts/fidelity/build-packs.sh high > target/hifi-logs/packs-high-4.log 2>&1 || { echo "packs failed"; exit 1; }
scripts/hifi/ctest.sh -L destruction -LE "known-failure|cumetal-open"
echo CHAIN5 DONE
