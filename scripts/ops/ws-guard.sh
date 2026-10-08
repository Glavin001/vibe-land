#!/bin/bash
# Run a GPU-heavy command (the native app, a GPU suite) so it cannot hang the
# desktop: every WS_GUARD_PERIOD_S (0.5) this asks WindowServer for its window
# list (scripts/ops/ws-probe). If the answer takes longer than WS_GUARD_LIMIT_MS
# (2000), the command's whole process group is stopped (TERM, then KILL).
#
#   scripts/ops/ws-guard.sh scripts/native-mac.sh run --scene town
#
# Why: on 2026-10-08 the native app on Vibe Town (high profile) starved
# WindowServer of the GPU for 40 s twice; macOS's watchdog killed WindowServer
# and logged the owner out. 2 s is far inside that 40 s and far above the
# probe's normal 45-60 ms. Exit 99 when the guard stopped the command; else the
# command's own status. The log line names the stall.
# Parsed whole before it runs ({ ...; exit; }).
{
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROBE_DIR="$ROOT/scripts/ops/ws-probe"
PROBE="$PROBE_DIR/ws_probe"
LIMIT_MS=${WS_GUARD_LIMIT_MS:-2000}
PERIOD=${WS_GUARD_PERIOD_S:-0.5}
[ $# -gt 0 ] || { echo "usage: ws-guard.sh CMD [ARGS...]" >&2; exit 2; }
if [ ! -x "$PROBE" ] || [ "$PROBE_DIR/ws_probe.c" -nt "$PROBE" ]; then
  clang -O2 -o "$PROBE" "$PROBE_DIR/ws_probe.c" -framework CoreGraphics -framework CoreFoundation || exit 2
fi
# The command in its own process group, so one signal stops all of it.
set -m
"$@" &
pid=$!
set +m
stop() {
  echo "[ws-guard] $1: stopping the command (process group $pid)" >&2
  kill -TERM -"$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -KILL -"$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  exit 99
}
trap 'kill -TERM -"$pid" 2>/dev/null; exit 130' INT TERM
limit_s=$(awk -v l="$LIMIT_MS" 'BEGIN{printf "%.1f", l/1000}')
while kill -0 "$pid" 2>/dev/null; do
  # The probe with its own deadline: a blocked WindowServer call never returns.
  ms=$(perl -e 'alarm shift; exec @ARGV' "$(awk -v l="$LIMIT_MS" 'BEGIN{print int(l/1000)+1}')" "$PROBE" 2>/dev/null)
  st=$?
  if [ $st -ne 0 ] || [ -z "$ms" ]; then stop "WindowServer did not answer within ${limit_s} s (probe status $st)"; fi
  if awk -v m="$ms" -v l="$LIMIT_MS" 'BEGIN{exit !(m>l)}'; then stop "WindowServer answered in $ms ms (limit $LIMIT_MS)"; fi
  sleep "$PERIOD"
done
wait "$pid"
exit $?
}
