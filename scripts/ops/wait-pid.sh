#!/bin/bash
# The one way to wait for a background job: scripts/ops/wait-pid.sh PID LIMIT_S [LOG]
#
# Returns as soon as PID exits (status 0) or after LIMIT_S seconds (status 124),
# then prints the last lines of LOG if given. It never polls a log for text and
# never uses `pgrep -f` (which matches the waiting loop itself), so it can't
# outlive its job. Run one waiter per job.
pid=${1:?usage: wait-pid.sh PID LIMIT_S [LOG]}; limit=${2:?usage: wait-pid.sh PID LIMIT_S [LOG]}; log=${3:-}
case $pid in *[!0-9]*) echo "wait-pid: '$pid' is not a pid" >&2; exit 2 ;; esac
end=$((SECONDS + limit)); status=0
while kill -0 "$pid" 2>/dev/null; do
  if [ $SECONDS -ge $end ]; then status=124; break; fi
  sleep 5
done
if [ $status = 0 ]; then echo "[wait-pid] $pid exited after ${SECONDS}s"
else echo "[wait-pid] $pid still running after ${limit}s (limit)"; fi
[ -n "$log" ] && [ -f "$log" ] && tail -n 15 "$log"
exit $status
