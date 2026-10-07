set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
while kill -0 73466 2>/dev/null; do sleep 20; done
scripts/hifi/film-town.sh runtime runtime
git merge --no-edit feat/native-macos-app || exit 1
(cd /Users/glavin/Development/vibe-land && PHYSX_SRC=/Users/glavin/Development/PhysX/.claude/worktrees/hifi GARAGE_SDK_NAME=garage-hifi scripts/perf/rebuild-garage-sdk.sh) > target/hifi-logs/sdk-6.log 2>&1 || { echo sdk failed; exit 1; }
tail -1 target/hifi-logs/sdk-6.log
scripts/hifi/ctest.sh -L destruction -LE "known-failure|cumetal-open"
git log --oneline -1
export TOWN_KIT_AUTHORING_ROOT=/Users/glavin/Development/PhysX/.claude/worktrees/hifi/blast/blast-stress-solver/structures
scripts/fidelity/build-packs.sh high > target/hifi-logs/packs-high-2.log 2>&1 || { echo packs failed; exit 1; }
python3 scripts/hifi/diag-strongheel.py
E="VIBE_TESTBED_SCENE_BONDS=1 PX_DESTRUCTION_IMPACT_LOG=1"
scripts/hifi/testbed.sh high rest2-sections-crush-no-impact rest $E VIBE_IMPACT_CAPACITY=0
scripts/hifi/testbed.sh high rest2-full-high rest $E
scripts/hifi/testbed.sh high rest2-no-impact-no-sections rest $E VIBE_IMPACT_CAPACITY=0 VIBE_SECTION_BENDING=0 VIBE_SECTION_ROTATION=0
echo CHAIN DONE
