#!/bin/bash
# Ceiling and scaling audit (scenarios/perf/audit): the intact city idling at
# growing grid sizes, then destroyed piles before and after every debris
# cluster is put to sleep. Samples the server's memory footprint every 2 s.
#   scripts/perf/ceiling-audit.sh [scenario ...]   (default: all)
# Runs vl from MAIN (the checkout with client/node_modules), with the server
# binary BIN (default: this checkout's garage-vehicles build). Results land in
# MAIN/target/vl/runs/audit-<scenario>; a one-line verdict per scenario in
# MAIN/target/vl/runs/audit-sweep.log.
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MAIN=${MAIN:-$(git -C "$HERE" worktree list | head -1 | awk '{print $1}')}
BIN=${BIN:-$HERE/target/garage-vehicles/release/web-fps-server}
LOG=$MAIN/target/vl/runs/audit-sweep.log
sample() {
  local out=$1; : > "$out"
  while true; do
    local pid; pid=$(pgrep -f "^$BIN" | head -1)
    if [ -n "$pid" ]; then
      local fp; fp=$(footprint -p "$pid" -f bytes 2>/dev/null | awk '/Footprint:/ {for(i=1;i<=NF;i++) if($i=="Footprint:") {print $(i+1); exit}}')
      echo "$(date +%s) $pid ${fp:-NA} $(ps -o rss= -p "$pid" | tr -d ' ')" >> "$out"
    fi
    sleep 2
  done
}
cd "$MAIN"
for name in ${@:-intact-g1 intact-g4 intact-g8 intact-g12 intact-g16 pile-g5 pile-g7}; do
  out=target/vl/runs/audit-$name
  rm -rf "$out"; mkdir -p "$out"
  sample "$out/memory.txt" & sp=$!
  start=$(date +%s)
  scripts/vl perf scenario "$HERE/scenarios/perf/audit/$name.json" --out "$out" --binary "$BIN" > "$out/vl.log" 2>&1
  echo "$name exit $? wall $(( $(date +%s) - start ))s" | tee -a "$LOG"
  kill $sp
done
