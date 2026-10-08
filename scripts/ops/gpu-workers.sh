# Adaptive GPU workers for a queue of one-trial jobs (sourced by
# scripts/verify/impact-arms.sh and scenario-repeats.sh).
#
# The runner starts its jobs with `xargs -P 2`; each job takes a worker token
# before it runs (worker_take DIR, worker_give at its end). Token 1 is always
# there. Token 2 is taken only while no other agent's job waits in gpu-run's
# queue (~/Library/Caches/vibe-land-gpu/queue), so a second concurrent run
# never starves someone else: with anyone waiting, the runner drops to one.
# "Another agent's" means a queued gpu-run whose process is not a descendant
# of this runner (GPU_WORKERS_TOP, the runner's pid, exported before xargs).
GPU_QUEUE_DIR="${VIBE_GPU_LOCK_DIR:-$HOME/Library/Caches/vibe-land-gpu}/queue"

# 0 when some queued gpu-run job is not ours.
foreign_waiting() {
  local f pid p
  for f in "$GPU_QUEUE_DIR"/*; do
    [ -f "$f" ] || continue
    pid=$(basename "$f"); kill -0 "$pid" 2>/dev/null || continue
    p=$pid
    while [ -n "$p" ] && [ "$p" != 1 ] && [ "$p" != 0 ] && [ "$p" != "${GPU_WORKERS_TOP:-x}" ]; do p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); done
    [ "$p" = "${GPU_WORKERS_TOP:-x}" ] || return 0
  done
  return 1
}

# worker_take DIR: wait for a token (token 2 only while nobody else waits).
worker_take() {
  local dir=$1 t owner
  while :; do
    for t in 1 2; do
      owner=$(cat "$dir/.worker-$t/pid" 2>/dev/null)
      [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && rm -rf "$dir/.worker-$t"
      [ "$t" = 2 ] && foreign_waiting && continue
      if mkdir "$dir/.worker-$t" 2>/dev/null; then echo $$ > "$dir/.worker-$t/pid"; WORKER_TOKEN=$dir/.worker-$t; return 0; fi
    done
    sleep 3
  done
}
worker_give() { [ -n "${WORKER_TOKEN:-}" ] && rm -rf "$WORKER_TOKEN"; WORKER_TOKEN=; }

# sdk_wait_current: until the high profile's SDK passes the provenance check
# again (sdk-follow.sh rebuilds within minutes of a push; bounded: 20 min).
sdk_wait_current() {
  local root=${GPU_WORKERS_ROOT:?} end=$((SECONDS + 1200))
  while [ $SECONDS -lt $end ]; do
    (source "$root/scripts/fidelity/high.env"; export PHYSX_ROOT=$(cd -P "$PHYSX_ROOT" && pwd); "$root/scripts/fidelity/provenance.sh" high > /dev/null 2>&1) && return 0
    sleep 20
  done
  return 1
}
