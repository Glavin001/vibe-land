#!/bin/bash
# Live check of VIBE_CITY_DEBRIS_DAMAGE against a running /city server
# (native destruction, default scene), driven by scripted WebTransport
# players (`debris_probe`, built beside web-fps-server):
#
#   scripts/debris-damage-live.sh <http port> <wt port> on|off [probe binary]
#
# 1. Wall: a player walks into the standing tower at (-42, -42) for 5 s.
#    Must stay at 100 HP whatever the flag.
# 2. Debris: reset the city, stand players 0.3, 3.6 and 7.6 m east of the
#    tower's east face, topple it east (/city-demolish, 60 degree wedge).
#    `on`: some player must lose HP (the server logs each strike under the
#    `debris_damage` target with its impulse). `off`: every player stays at 100.
#
# The server must run with VIBE_CITY_DEBRIS_DAMAGE matching the mode; this
# script cannot see the server's environment, so it trusts the argument.
set -u
http=${1:?http port}; wt=${2:?wt port}; mode=${3:?on|off}
probe=${4:-$(dirname "$0")/../target/release/debris_probe}
api=http://127.0.0.1:$http
out=$(mktemp -d)
fail=0

curl -s -X POST "$api/city-reset/city-default" > /dev/null
sleep 3
"$probe" --api "$api" --wt-port "$wt" --pos -29,2,-42 --yaw -1.5708 --duration 15 --walk 3,8 > "$out/wall.log" 2>&1
wall_hp=$(grep -Eo 'hp [0-9]+' "$out/wall.log" | sort -u | tr '\n' ' ')
wall_x=$(grep 'pos (' "$out/wall.log" | tail -1 | sed -E 's/.*pos \(([^,]+),.*/\1/')
echo "wall: stopped at x=$wall_x, hp seen: $wall_hp"
[ "$wall_hp" = "hp 100 " ] || { echo "FAIL: walking into the wall changed HP"; fail=1; }

curl -s -X POST "$api/city-reset/city-default" > /dev/null
sleep 3
pids=""
for x in -32.3 -29 -25; do
  "$probe" --api "$api" --wt-port "$wt" --pos "$x,2,-42" --yaw -1.5708 --duration 40 > "$out/probe$x.log" 2>&1 &
  pids="$pids $!"; sleep 0.3
done
sleep 8
curl -s -X POST "$api/city-demolish/city-default" -H 'Content-Type: application/json' \
  -d '{"x":-42,"z":-42,"tallest":false,"radius_m":12,"below_y":6,"rounds":96,"wedge_deg":60,"heading_deg":0,"jitter":0.3,"per_tick":8}' > /dev/null
for p in $pids; do wait "$p"; done
hurt=0
for x in -32.3 -29 -25; do
  changes=$(grep -c '(was ' "$out/probe$x.log")
  echo "player at x=$x: $changes HP changes"; grep '(was ' "$out/probe$x.log" | sed 's/^/  /'
  [ "$changes" -gt 0 ] && hurt=1
done
if [ "$mode" = on ] && [ $hurt = 0 ]; then echo "FAIL: no player took debris damage with the flag on"; fail=1; fi
if [ "$mode" = off ] && [ $hurt = 1 ]; then echo "FAIL: a player's HP changed with the flag off"; fail=1; fi
[ $fail = 0 ] && echo "PASS ($mode)"
exit $fail
