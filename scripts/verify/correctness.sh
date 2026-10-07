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
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tier=${1:-quick}
only=textbook,regressions,acceptance
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
I=/Users/glavin/Development/PhysX/out/install
export RUNTIME_SDK=${RUNTIME_PHYSX_ROOT:-$I/garage-roof}
# High-fidelity runs on high.env's SDK (integration/high-fidelity, garage-hifi: every
# capability). These remain for the single-feature regression tests.
export ROTATION_SDK=${VERIFY_ROTATION_PHYSX_ROOT:-$I/garage-multihull}
export CRUSH_SDK=${VERIFY_CRUSH_PHYSX_ROOT:-/Users/glavin/Development/PhysX/.claude/worktrees/hifi/out/install/garage-hifi}
export PHYSX_BUILD=${VERIFY_PHYSX_BUILD:-/Users/glavin/Development/PhysX/out/build/garage-multihull/package}
export IMPACT_BUILD=${VERIFY_IMPACT_BUILD:-/Users/glavin/Development/PhysX/.claude/worktrees/impact-e/out/build/impact-e-tests}
t_start=$(date +%s)
failed=0

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
    cd "$ROOT" && cargo test -p vibe-land-physx-bridge --features native-destruction --test textbook \
      -- --ignored --test-threads=1 --nocapture > "$out/textbook-$label.log" 2>&1
  )
  local rc=$?
  echo "[verify] textbook $label: $(grep -hE '^[a-z+()-]+: [0-9]+ checks' "$out/textbook-$label.log" || echo "did not finish (see textbook-$label.log)")"
  # A run that did not finish (build error, configuration rejected) is a failure.
  grep -qE 'checks, ' "$out/textbook-$label.log" || { echo "{\"config\":\"$label\",\"case\":\"(suite)\",\"check\":\"ran to completion\",\"status\":\"FAIL\",\"error\":null,\"textbook\":null,\"stage\":null,\"model\":null,\"unit\":\"\",\"formula\":\"\",\"source\":\"$(grep -m1 -E 'panicked|error' "$out/textbook-$label.log" | tr '"' "'" | cut -c1-200)\"}" >> "$out/textbook-$label.jsonl"; }
  return $rc
}

if want textbook; then
  textbook runtime runtime || failed=1
  textbook high high || failed=1
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
    if (cd "$ROOT" && bash -c "$cmd") > "$out/regression-$id.log" 2>&1; then st=PASS; else st=FAIL; failed=1; fi
    dt=$(( $(date +%s) - t0 ))
    echo "[verify] regression $id: $st (${dt}s)"
    echo "{\"id\":\"$id\",\"what\":$(printf '%s' "$what" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"status\":\"$st\",\"seconds\":$dt}" >> "$out/regressions.jsonl"
  done < "$ROOT/scripts/verify/regressions.tsv"
fi

if want acceptance; then
  for p in runtime high; do
    # High-fidelity on high.env's SDK (the combined garage-hifi install);
    # VERIFY_HIGH_PHYSX_ROOT picks another.
    HIGH_PHYSX_ROOT=${VERIFY_HIGH_PHYSX_ROOT:-} "$ROOT/scripts/verify/acceptance.sh" "$p" "$out/acceptance-$p" > "$out/acceptance-$p.log" 2>&1 || failed=1
    echo "[verify] acceptance $p: $(grep -c '"status":"PASS"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) pass, $(grep -c '"status":"KNOWN-GAP"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) known gaps, $(grep -c '"status":"FAIL"' "$out/acceptance-$p/acceptance.jsonl" 2>/dev/null) failing"
  done
fi

python3 "$ROOT/scripts/verify/report.py" "$out" | tee "$out/report.md"
echo "[verify] $tier tier took $(( $(date +%s) - t_start )) s; results in $out"
exit $failed
