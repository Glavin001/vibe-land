# After chain-rest3: rebuild garage-hifi with the impact solve's convergence
# fix, check the impact ctest, then the high house trials (impact log on).
set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
while kill -0 ${WAIT_PID:?} 2>/dev/null; do sleep 20; done
(cd /Users/glavin/Development/vibe-land && PHYSX_SRC=/Users/glavin/Development/PhysX/.claude/worktrees/hifi GARAGE_SDK_NAME=garage-hifi scripts/perf/rebuild-garage-sdk.sh) > target/hifi-logs/sdk-8.log 2>&1 || { echo "sdk failed"; exit 1; }
tail -1 target/hifi-logs/sdk-8.log
scripts/hifi/ctest.sh -R "destruction_gpu_impact_capacity"
T=framed-house,framed-house-corner,cannonball-framed-house,meteor-framed-house,smallshots-framed-house
scripts/hifi/testbed.sh high hifi-high-houses $T VIBE_TESTBED_SCENE_BONDS=1 PX_DESTRUCTION_IMPACT_LOG=1
echo CHAIN4 DONE
