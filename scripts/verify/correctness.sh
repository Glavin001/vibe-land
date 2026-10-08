#!/bin/bash
# The correctness suite: textbook verification of the GPU destruction stage,
# regression tests for accuracy fixes, and the acceptance scenarios, in both
# engine profiles (runtime = what ships, high = every accuracy capability on).
#
#   scripts/verify/correctness.sh quick     ~5 min: textbook statics, failure and gravity
#                                           cases in runtime and high-fidelity; the quick
#                                           regression tests
#   scripts/verify/correctness.sh full      ~1.5-2 h: + refinement study, rest near capacity,
#                                           section-bending alone, high-fidelity on the
#                                           impact-capacity SDK, every regression test, and
#                                           the acceptance scenarios in both profiles
#   ... --only textbook,regressions,acceptance
#
# Prints one table an engineer can read (scripts/verify/report.py) and writes
# target/verify/<stamp>/{report.md,*.jsonl,*.log}. Exit 1 if anything FAILs
# (a known gap that got worse counts; a known gap that holds does not).
# Correctness runs share the GPU (VIBE_GPU_SHARED=1); nothing here takes the lock.
# See docs/verification/README.md.
# Parsed whole before it runs ({ ...; exit; }): an edit to this file while it
# runs cannot shift a running copy (bash reads scripts as it goes). Still,
# replace it with a temp file and mv, never edit it in place.
{
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tier=${1:-quick}
only=textbook,regressions,acceptance,scenarios,flagmatrix
[ "$tier" = quick ] && only=textbook,regressions
[ "${2:-}" = --only ] && only=${3:?}
want() { [[ ",$only," == *",$1,"* ]]; }
stamp=$(date +%Y%m%d-%H%M%S)
out=${VERIFY_OUT_DIR:-$ROOT/target/verify/$stamp}
mkdir -p "$out"
out=$(cd "$out" && pwd)  # absolute: cargo runs tests from the package directory
export VIBE_GPU_SHARED=1
# The product's stage environment, as a backstop for any GPU test that does not
# set it itself (physx-bridge/tests/common/stage_env.rs; lint-gpu-test-env.sh).
export PX_DESTRUCTION_ALLOW_UNCONVERGED=1
# The impact solve's bug detectors (PhysX d4d37749c) print to the logs: a
# diverged solve, or a GPU dispatch past 100 ms (machine safety). Both fail
# the job that logged them (bug_signals below).
export PX_DESTRUCTION_IMPACT_LOG=1
I=/Users/glavin/Development/PhysX/out/install
export RUNTIME_SDK=${RUNTIME_PHYSX_ROOT:-$I/garage-roof}
# The single-feature regression tests run on high.env's SDK, read from high.env
# itself so they cannot drift from it (2026-10-08: they ran on a retired SDK
# after high.env moved), and checked by its provenance below.
HIGH_ENV_SDK=$(env -u HIGH_PHYSX_ROOT bash -c 'source "$1" >/dev/null 2>&1; echo "$PHYSX_ROOT"' _ "$ROOT/scripts/fidelity/high.env")
export ROTATION_SDK=${VERIFY_ROTATION_PHYSX_ROOT:-$HIGH_ENV_SDK}
export CRUSH_SDK=${VERIFY_CRUSH_PHYSX_ROOT:-$HIGH_ENV_SDK}
export PHYSX_BUILD=${VERIFY_PHYSX_BUILD:-/Users/glavin/Development/PhysX/.claude/worktrees/clean/out/build/clean-package}
# The PhysX destruction ctest gate's package tree: the clean branch's tests,
# built against garage-clean's libraries (cmake -S destruction, BUILD_TESTING=ON).
export DESTRUCTION_CTEST_TREE=${VERIFY_DESTRUCTION_CTEST_TREE:-/Users/glavin/Development/PhysX/.claude/worktrees/clean/out/build/clean-package}
export IMPACT_BUILD=${VERIFY_IMPACT_BUILD:-/Users/glavin/Development/PhysX/.claude/worktrees/impact-e/out/build/impact-e-tests}
t_start=$(date +%s)
failed=0

# A GPU environment failure, not a test failure: another process's long GPU work
# timed this one's command buffers out (Metal), which PhysX reports as CUDA error 2.
env_failure() { grep -qE 'kIOGPUCommandBufferCallbackErrorTimeout|CUDA error 2\b|cudaErrorMemoryAllocation|CUDA_ERROR_LAUNCH_TIMEOUT|^STALLED' "$1"; }

# Every GPU job goes through the machine-wide admission (at most VIBE_GPU_SLOTS
# shared jobs at once, by the main checkout's path), one at a time from here.
GPU_RUN=/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh

# watched LOG CMD...: run CMD with its output in LOG; if LOG stops growing for
# VERIFY_STALL_S (default 600) s -- a process stuck in an uninterruptible GPU wait
# behind another process's hung dispatch -- kill it and mark the log STALLED.
watched() {
  local log=$1; shift
  "$@" > "$log" 2>&1 &
  local pid=$! last=$(date +%s) size=-1
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    local now=$(date +%s) cur=$(stat -f %z "$log" 2>/dev/null || echo 0)
    if [ "$cur" != "$size" ]; then size=$cur; last=$now; fi
    if [ $(( now - last )) -ge "${VERIFY_STALL_S:-600}" ]; then
      pkill -9 -P "$pid" 2>/dev/null; kill -9 "$pid" 2>/dev/null
      echo "STALLED: no output for ${VERIFY_STALL_S:-600} s (a GPU wait that never returned); killed" >> "$log"
      return 124
    fi
  done
  wait "$pid"
}

# bug_signals LOG: the impact solve's diverged solves and over-100-ms dispatches.
# Older SDKs print no warning, only "(longest N ms)" per evaluation: read that too.
bug_signals() {
  { grep -hE '\[impact\] DIVERGED|\[impact\] warning: a dispatch took' "$@" 2>/dev/null
    grep -hoE '\(longest [0-9.]+ ms\)' "$@" 2>/dev/null | awk '{ if ($2 + 0 > 100) print "[impact] a dispatch took " $2 " ms (over 100 ms)" }'
  } | sort | uniq -c | sort -rn | head -5
}

has() { grep -q "#define $2 1" "$1/include/physx/PxDestructionScene.h" 2>/dev/null; }

# textbook LABEL PROFILE [SDK]: one engine configuration, one process.
textbook() {
  local label=$1 profile=$2 sdk=${3:-}
  (
    case $profile in
      runtime) source "$ROOT/scripts/fidelity/runtime.env" ;;
      high) source "$ROOT/scripts/fidelity/high.env"
            [ -n "$sdk" ] && export PHYSX_ROOT=$sdk ;;
      bending) source "$ROOT/scripts/fidelity/runtime.env"; export VIBE_SECTION_BENDING=1 ;;
    esac
    source "$ROOT/scripts/fidelity/check.sh" --degrade > "$out/textbook-$label.fidelity" 2>&1
    export CARGO_TARGET_DIR=$ROOT/target/verify-$(basename "$PHYSX_ROOT")
    export VERIFY_TIER=$tier VERIFY_OUT=$out/textbook-$label.jsonl
    cd "$ROOT"
    for attempt in 1 2; do
      rm -f "$VERIFY_OUT"
      watched "$out/textbook-$label.log" "$GPU_RUN" "verify-textbook-$label" cargo test -p vibe-land-physx-bridge --features native-destruction --test textbook \
        -- --ignored --test-threads=1 --nocapture && break
      env_failure "$out/textbook-$label.log" || break
      echo "[verify] textbook $label: GPU environment failure, rerunning"
    done
  )
  local rc=$?
  local sig; sig=$(bug_signals "$out/textbook-$label.log")
  if [ -n "$sig" ]; then
    echo "[verify] textbook $label: IMPACT BUG SIGNALS: $sig"
    echo "{\"config\":\"$label\",\"case\":\"(impact solve)\",\"check\":\"no diverged solve, no dispatch over 100 ms\",\"status\":\"FAIL\",\"error\":null,\"textbook\":null,\"stage\":null,\"model\":null,\"unit\":\"\",\"formula\":\"\",\"source\":\"$(echo $sig | tr -d '\"' | cut -c1-200)\"}" >> "$out/textbook-$label.jsonl"
    rc=1
  fi
  echo "[verify] textbook $label: $(grep -hE '^[a-z+()-]+: [0-9]+ checks' "$out/textbook-$label.log" || echo "did not finish (see textbook-$label.log)")"
  # A run that did not finish (build error, configuration rejected) is a failure.
  grep -qE 'checks, ' "$out/textbook-$label.log" || { echo "{\"config\":\"$label\",\"case\":\"(suite)\",\"check\":\"ran to completion\",\"status\":\"FAIL\",\"error\":null,\"textbook\":null,\"stage\":null,\"model\":null,\"unit\":\"\",\"formula\":\"\",\"source\":\"$(grep -m1 -E 'panicked|error' "$out/textbook-$label.log" | tr '"' "'" | cut -c1-200)\"}" >> "$out/textbook-$label.jsonl"; }
  return $rc
}

# Provenance first: it rebuilds stale high-fidelity packs (which the anchor lint
# and acceptance read) and refuses a stale or dirty high SDK.
high_ok=0
(source "$ROOT/scripts/fidelity/high.env"; "$ROOT/scripts/fidelity/provenance.sh" high) > "$out/provenance-high.log" 2>&1 && high_ok=1
echo "[verify] provenance high: $(grep -m1 'high: ' "$out/provenance-high.log")"

if want textbook; then
  textbook runtime runtime || failed=1
  if [ "$high_ok" = 1 ]; then
    textbook high high || failed=1
  else
    echo "[verify] textbook high: REFUSED, $(grep -m1 'high: ' "$out/provenance-high.log")"
    echo '{"config":"high-fidelity","case":"(provenance)","check":"SDK and packs current","status":"FAIL","error":null,"textbook":null,"stage":null,"model":null,"unit":"","formula":"","source":"see provenance-high.log"}' >> "$out/textbook-high.jsonl"
    failed=1
  fi
  if [ "$tier" = full ]; then
    textbook section-bending bending || failed=1
  fi
fi

if want regressions; then
  : > "$out/regressions.jsonl"
  while IFS=$'\t' read -r id rtier profile what cmd; do
    [[ -z "$id" || "$id" == \#* ]] && continue
    [ "$tier" = quick ] && [ "$rtier" = full ] && continue
    if [[ "$cmd" == \(* ]]; then  # covered elsewhere (textbook, acceptance) or not runnable here
      echo "{\"id\":\"$id\",\"what\":$(printf '%s' "$what" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"status\":\"$(echo "$cmd" | tr -d '()"' | cut -c1-60)\",\"seconds\":0}" >> "$out/regressions.jsonl"
      continue
    fi
    t0=$(date +%s)
    # PhysX's own ctests set the stage's convergence mode per test (strict tests
    # pin it to 0): never hand them the product backstop.
    [[ "$cmd" == *ctest* ]] && cmd="unset PX_DESTRUCTION_ALLOW_UNCONVERGED; $cmd"
    st=FAIL
    for attempt in 1 2; do
      gpu=()
      [[ "$cmd" == *native-destruction* || "$cmd" == *ctest* ]] && gpu=("$GPU_RUN" "verify-regression-$id")
      if (cd "$ROOT" && watched "$out/regression-$id.log" ${gpu[@]+"${gpu[@]}"} bash -c "$cmd"); then st=PASS; break; fi
      # Another process's long GPU dispatch can time out this one's command
      # buffers: an environment failure, rerun once, then reported as ENV.
      if env_failure "$out/regression-$id.log"; then st=ENV; echo "[verify] regression $id: GPU environment failure, rerunning"; continue; fi
      st=FAIL; break
    done
    [ "$st" = PASS ] && [ -n "$(bug_signals "$out/regression-$id.log")" ] && { st=FAIL; echo "[verify] regression $id: impact bug signals: $(bug_signals "$out/regression-$id.log" | tr '\n' ' ')"; }
    [ "$st" = FAIL ] && failed=1
    dt=$(( $(date +%s) - t0 ))
    echo "[verify] regression $id: $st (${dt}s)"
    echo "{\"id\":\"$id\",\"what\":$(printf '%s' "$what" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"status\":\"$st\",\"seconds\":$dt}" >> "$out/regressions.jsonl"
  done < "$ROOT/scripts/verify/regressions.tsv"
fi

if want acceptance; then
  for p in runtime high; do
    # High-fidelity on high.env's SDK (garage-clean);
    # VERIFY_HIGH_PHYSX_ROOT picks another.
    HIGH_PHYSX_ROOT=${VERIFY_HIGH_PHYSX_ROOT:-} "$ROOT/scripts/verify/acceptance.sh" "$p" "$out/acceptance-$p" > "$out/acceptance-$p.log" 2>&1 || failed=1
    sig=$(bug_signals "$out/acceptance-$p"/*.log "$ROOT/target/vehicle-testbed/verify-acceptance-$p.log")
    [ -n "$sig" ] && { echo "[verify] acceptance $p: IMPACT BUG SIGNALS: $(echo "$sig" | tr '\n' ' ')"; failed=1; }
    echo "[verify] acceptance $p: $(grep -c '"status":"PASS"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) pass, $(grep -c '"status":"KNOWN-GAP"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) known gaps, $(grep -c '"status":"FAIL"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) failing"
  done
fi

if want scenarios; then
  # The scenario-outcome matrix (docs/verification/SCENARIOS.md): gated in the
  # high-fidelity profile, reported in runtime.
  for p in runtime high; do
    HIGH_PHYSX_ROOT=${VERIFY_HIGH_PHYSX_ROOT:-} "$ROOT/scripts/verify/scenarios.sh" "$p" > "$out/scenarios-$p.log" 2>&1
    st=$?
    cp -R "$ROOT/target/verify/scenarios-$p" "$out/" 2>/dev/null
    echo "[verify] scenarios $p: $(tail -1 "$out/scenarios-$p.log")"
    [ "$p" = high ] && [ $st != 0 ] && failed=1
  done
fi

if want flagmatrix; then
  "$ROOT/scripts/verify/flag-matrix.sh" "$out/flag-matrix" > "$out/flag-matrix.log" 2>&1
  grep '^\[flag-matrix\]' "$out/flag-matrix.log"
  python3 -c "
import json,sys
rs=[json.loads(l) for l in open('$out/flag-matrix/flag-matrix.jsonl')]
sys.exit(1 if any(r['broken_pct'] is None or r['broken_pct']>0 for r in rs) else 0)" || failed=1
fi

python3 "$ROOT/scripts/verify/report.py" "$out" | tee "$out/report.md"
echo "[verify] $tier tier took $(( $(date +%s) - t_start )) s; results in $out"
exit $failed
}
