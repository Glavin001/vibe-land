#!/bin/bash
# Every physx-bridge test file that attaches the native destruction stage must
# set the product's stage environment (tests/common/stage_env.rs: product() or,
# for a test of the strict mode, strict_converged()), or set
# PX_DESTRUCTION_ALLOW_UNCONVERGED itself. Without it a test runs a mode the game
# never runs and fails on its first unconverged step ("PhysX fetchResults failed").
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
bad=0
for f in "$ROOT"/physx-bridge/tests/*.rs "$ROOT"/physx-bridge/tests/*/*.rs; do
  case $f in */common/*) continue ;; esac
  grep -q 'native_attach' "$f" || continue
  dir=$(dirname "$f")
  # a test directory (tests/NAME/main.rs + modules) counts as one file
  if [ "$(basename "$dir")" != tests ]; then src=$(cat "$dir"/*.rs); else src=$(cat "$f"); fi
  if ! grep -qE 'stage_env::(product|strict_converged)|PX_DESTRUCTION_ALLOW_UNCONVERGED' <<<"$src"; then
    echo "missing the product stage environment: ${f#$ROOT/}"; bad=1
  fi
done
[ $bad = 0 ] && echo "every native-stage GPU test sets the product stage environment"
exit $bad
