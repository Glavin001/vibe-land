# After chain-rest2 and the small-shots retake: merge the impact solve's
# quiet-at-rest work, section rotation's bearing joints and feat/native-macos-app, rebuild, rerun the at-rest arms.
set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
while kill -0 ${WAIT_PID:?} 2>/dev/null; do sleep 20; done
(cd /Users/glavin/Development/PhysX/.claude/worktrees/hifi && git merge --no-ff --no-edit feat/impact-capacity && git merge --no-ff --no-edit feat/section-rotational-stiffness) || { echo "physx merge failed"; exit 1; }
git merge --no-edit feat/native-macos-app || { echo "vibe merge failed"; exit 1; }
(cd /Users/glavin/Development/vibe-land && PHYSX_SRC=/Users/glavin/Development/PhysX/.claude/worktrees/hifi GARAGE_SDK_NAME=garage-hifi scripts/perf/rebuild-garage-sdk.sh) > target/hifi-logs/sdk-7.log 2>&1 || { echo "sdk failed"; exit 1; }
tail -1 target/hifi-logs/sdk-7.log
scripts/hifi/ctest.sh -L destruction -LE "known-failure|cumetal-open"
export TOWN_KIT_AUTHORING_ROOT=/Users/glavin/Development/PhysX/.claude/worktrees/hifi/blast/blast-stress-solver/structures
scripts/fidelity/build-packs.sh high > target/hifi-logs/packs-high-3.log 2>&1 || { echo "packs failed"; exit 1; }
E="VIBE_TESTBED_SCENE_BONDS=1 PX_DESTRUCTION_IMPACT_LOG=1"
scripts/hifi/testbed.sh high rest3-full-high rest $E
scripts/hifi/testbed.sh high rest3-sections-crush-no-impact rest $E VIBE_IMPACT_CAPACITY=0
scripts/hifi/testbed.sh runtime rest3-runtime rest VIBE_TESTBED_SCENE_BONDS=1
echo CHAIN3 DONE
