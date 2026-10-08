# The high-fidelity takes, one trial at a time (one GPU job at a time): the
# headless test bed measures it (houses.py), the native app films it with the
# same cameras and cues as the runtime take, then the side-by-side.
set -x
cd /Users/glavin/Development/vibe-land/.claude/worktrees/hifi
while kill -0 ${WAIT_PID:?} 2>/dev/null; do sleep 20; done
grep -q "CHAIN5 DONE" target/hifi-logs/queue-17.out || { echo "rebuild chain failed"; exit 1; }
V=target/native-video
runtime_take() { case $1 in
  cannonball-framed-house) echo $V/vehicle-lab-20261007-071003-final.mp4 ;; smallshots-framed-house) echo $V/vehicle-lab-20261007-080718-final.mp4 ;;
  meteor-framed-house) echo $V/vehicle-lab-20261007-071202-final.mp4 ;; framed-house) echo $V/runtime-framed-house-final.mp4 ;;
  framed-house-corner) echo $V/vehicle-lab-20261007-070704-final.mp4 ;; esac; }
[ -f target/hifi-logs/houses-high.json ] || echo '{}' > target/hifi-logs/houses-high.json
for t in cannonball-framed-house smallshots-framed-house meteor-framed-house framed-house framed-house-corner; do
  scripts/hifi/testbed.sh high hh-$t $t VIBE_TESTBED_SCENE_BONDS=1 PX_DESTRUCTION_IMPACT_LOG=1
  python3 scripts/hifi/houses.py hh-$t --json=target/hifi-logs/hh-$t.json
  python3 -c "import json,sys;a=json.load(open('target/hifi-logs/houses-high.json'));a.update(json.load(open('target/hifi-logs/hh-$t.json')));json.dump(a,open('target/hifi-logs/houses-high.json','w'),indent=1)"
  scripts/hifi/film-houses.sh high "high fidelity" $t
  hv=$(grep "^$t " target/hifi-logs/films-high.txt | tail -1 | awk '{print $2}')
  [ -f "$hv" ] && python3 scripts/hifi/sbs.py $t "$(runtime_take $t)" "$hv" $V/sbs-$t.mp4 && echo "SBS $t $V/sbs-$t-share.mp4"
done
echo CHAIN6 DONE
