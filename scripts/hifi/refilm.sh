# Re-film all five before/after side-by-sides on a fresh impact-capacity head:
# merge it (and section rotation, native-macos-app), rebuild garage-hifi once,
# high packs, the destruction gate, then chain-films6.sh (cannonball first).
#   scripts/hifi/detach.sh target/hifi-logs/queue-refilm.out "bash scripts/hifi/refilm.sh"
set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
(cd /Users/glavin/Development/PhysX/.claude/worktrees/hifi && git merge --no-ff --no-edit feat/impact-capacity && git merge --no-ff --no-edit feat/section-rotational-stiffness) || { echo "physx merge failed"; exit 1; }
git merge --no-edit feat/native-macos-app || { echo "vibe merge failed"; exit 1; }
for t in cannonball-framed-house smallshots-framed-house meteor-framed-house framed-house framed-house-corner; do
  sed -i '' "/^$t /d" target/hifi-logs/films-high.txt 2>/dev/null; done
echo '{}' > target/hifi-logs/houses-high.json
bash scripts/hifi/chain-sdk5.sh > target/hifi-logs/queue-17.out 2>&1

WAIT_PID=999999 bash scripts/hifi/chain-films6.sh
