#!/usr/bin/env bash
# Deploy the Lever A build (A1+A2 behind VIBE_PHYSX_CONTACT_FASTPATH, default
# on) plus the cuda-stress guards. Gates already ran green in
# cbA-gate-and-measure.sh; this only swaps the hardlink and restarts.
#
# Kill by PID list, never pkill: comm is truncated at 15 chars and an inline
# wrapper matches its own command line.
set -uo pipefail
cd /root/workspace/vibe-land-4
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

srv_pid=$(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1; exit}')
if [ -n "$srv_pid" ]; then
  cp "/proc/$srv_pid/exe" /tmp/web-fps-server-prev
  log "previous serving binary saved (inode $(stat -L -c %i /proc/$srv_pid/exe))"
fi
for pid in $(ps -eo pid,args | awk '/[r]un-vl4-server.sh/{print $1}'); do kill "$pid" 2>/dev/null || true; done
sleep 1
for pid in $(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1}'); do kill "$pid" 2>/dev/null || true; done
for _ in $(seq 1 30); do ps -eo args | grep -q "[w]eb-fps-server-vl4" || break; sleep 1; done

ln -f target/release/web-fps-server target/release/web-fps-server-vl4
log "deployed inode $(stat -L -c %i target/release/web-fps-server-vl4) (built $(stat -L -c %y target/release/web-fps-server-vl4))"

nohup setsid bash scripts/run-vl4-server.sh >/dev/null 2>&1 &
sleep 10
curl -sk https://127.0.0.1:8384/healthz
echo
new_pid=$(ps -eo pid,args | awk '/[w]eb-fps-server-vl4/{print $1; exit}')
log "serving pid=$new_pid inode=$(stat -L -c %i /proc/$new_pid/exe 2>/dev/null)"
log "DEPLOY DONE"
