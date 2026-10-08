#!/bin/bash
# Keep the high-fidelity SDK on every PhysX feature branch's head:
#   scripts/ops/sdk-follow.sh [--once] [--interval 60]
# Every interval (60 s) it reads the heads of the PhysX branches in
# scripts/fidelity/branches.tsv and scripts/ops/sdk-follow.tsv (build-only). When one is not in integration/high-fidelity
# (the hifi worktree), it merges each such branch there and rebuilds and installs
# the versioned SDK (scripts/perf/rebuild-garage-sdk.sh: garage-hifi@<rev> behind
# the garage-hifi link) through gpu-run.sh on a shared slot. A branch that moves
# again during a build is picked up by the next check, so a burst of commits costs
# one more build, not one per commit. In-flight runs keep the revision they started
# on; new runs start at most one build behind (about 5-10 min).
# One line per event on stdout (and in target/ops/sdk-follow.log):
#   rebuilt <rev> with <branch> <head>, ...
#   CONFLICT merging <branch> <head>: merge aborted, nothing built (a person resolves it)
#   BUILD FAILED at <rev>: <log>
#   DIRTY: the hifi worktree has local changes; nothing merged
# A conflict or failure is reported, never resolved here; the loop keeps
# watching and retries only once the branch heads move again.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SRC=${SDK_FOLLOW_SRC:-$(cd "$ROOT/.." && pwd)/PhysX/.claude/worktrees/hifi}
NAME=${SDK_FOLLOW_NAME:-garage-hifi}
INTEGRATION=${SDK_FOLLOW_BRANCH:-integration/high-fidelity}
interval=60 once=0
while [ $# -gt 0 ]; do
  case $1 in --once) once=1; shift ;; --interval) interval=$2; shift 2 ;; *) echo "usage: sdk-follow.sh [--once] [--interval S]" >&2; exit 2 ;; esac
done
mkdir -p "$ROOT/target/ops"
LOG=$ROOT/target/ops/sdk-follow.log
lock=$ROOT/target/ops/sdk-follow.pid
if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null && [ "$(cat "$lock")" != $$ ]; then
  echo "sdk-follow: already running as $(cat "$lock")" >&2; exit 1
fi
echo $$ > "$lock"; trap 'rm -f "$lock"' EXIT
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
# The PhysX branches the high profile needs (the first name of an a|b pair), and
# the build-only ones (scripts/ops/sdk-follow.tsv: not provenance, never "stale").
branches() { awk -F'\t' '$1=="physx"{split($2,a,"|"); print a[1]}' "$ROOT/scripts/fidelity/branches.tsv" "$ROOT/scripts/ops/sdk-follow.tsv"; }
failed_at=""   # the branch heads a conflict or failed build was seen at: retry only when they move
say "following $(branches | paste -sd, -) into $INTEGRATION ($SRC), installing $NAME@<rev>"
while true; do
  [ "$(git -C "$SRC" branch --show-current)" = "$INTEGRATION" ] || { say "NOT ON $INTEGRATION: $SRC is on $(git -C "$SRC" branch --show-current); nothing merged"; [ $once = 1 ] && exit 1; sleep "$interval"; continue; }
  moved=() state=""
  for b in $(branches); do
    head=$(git -C "$SRC" rev-parse --verify -q "$b^{commit}") || continue
    state+="$b=$head "
    git -C "$SRC" merge-base --is-ancestor "$head" HEAD || moved+=("$b")
  done
  if [ ${#moved[@]} -gt 0 ] && [ "$state" != "$failed_at" ]; then
    if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
      say "DIRTY: $SRC has local changes; nothing merged"; failed_at=$state
    else
      merged=() ok=1
      for b in "${moved[@]}"; do
        h=$(git -C "$SRC" rev-parse --short "$b")
        if git -C "$SRC" merge --no-ff --no-edit "$b" > "$ROOT/target/ops/sdk-follow-merge.log" 2>&1; then merged+=("$b $h")
        else
          git -C "$SRC" merge --abort 2>/dev/null
          say "CONFLICT merging $b $h into $INTEGRATION: merge aborted, nothing built ($(grep -m3 CONFLICT "$ROOT/target/ops/sdk-follow-merge.log" | paste -sd';' -))"
          ok=0; failed_at=$state; break
        fi
      done
      if [ $ok = 1 ]; then
        rev=$(git -C "$SRC" rev-parse --short=9 HEAD)
        build=$ROOT/target/ops/sdk-follow-build-$rev.log
        if VIBE_GPU_SHARED=1 "$ROOT/scripts/perf/gpu-run.sh" sdk-follow env VIBE_GPU_SHARED=1 PHYSX_SRC="$SRC" GARAGE_SDK_NAME="$NAME" \
             "$ROOT/scripts/perf/rebuild-garage-sdk.sh" > "$build" 2>&1; then
          say "rebuilt $rev with $(IFS=,; echo "${merged[*]}")"
          failed_at=""
        else
          say "BUILD FAILED at $rev ($(IFS=,; echo "${merged[*]}")): $build"
          failed_at=$state
        fi
        continue   # check again at once: a branch may have moved during the build
      fi
    fi
  fi
  [ $once = 1 ] && exit 0
  sleep "$interval"
done
