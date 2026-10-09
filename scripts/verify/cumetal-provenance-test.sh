#!/bin/bash
# provenance.sh must refuse a high SDK whose GPU code came from a stale or dirty
# CuMetal (2026-10-09: the upstream merge changed the compiler under every SDK;
# nothing would have said that an SDK predated it). On a copy of high.env's SDK
# manifest, with its cumetal-revision rewritten:
#   - the parent of the last compiler/runtime commit: refused, naming CuMetal;
#   - the current head, marked dirty: refused;
#   - the current head, clean: no CuMetal problem.
# CPU only. Exit 1 on any wrong verdict.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CM=${CUMETAL_ROOT:-$(cd "$ROOT/../cuda-metal" 2>/dev/null && pwd -P || echo /Users/glavin/Development/cuda-metal)}
sdk=$(env -u HIGH_PHYSX_ROOT bash -c 'source "$1" >/dev/null 2>&1; echo "$PHYSX_ROOT"' _ "$ROOT/scripts/fidelity/high.env")
work=$(mktemp -d "${TMPDIR:-/tmp}/cumetal-provenance.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$sdk/sdk-artifacts.json" "$work/" || { echo "FAIL: no sdk-artifacts.json in $sdk"; exit 1; }
head=$(git -C "$CM" rev-parse HEAD)
last=$(git -C "$CM" log -1 --format=%H -- compiler runtime)
old=$(git -C "$CM" rev-parse "$last~1")
fail=0
verdict() { # LABEL REV STATE EXPECT(refused|current)
  echo "$2 $3 $CM" > "$work/cumetal-revision"
  local log; log=$(PHYSX_ROOT=$work "$ROOT/scripts/fidelity/provenance.sh" high 2>&1)
  if grep -q "SDK's CuMetal" <<<"$log"; then got=refused; else got=current; fi
  if [ "$got" = "$4" ]; then echo "PASS: $1: $got"
  else echo "FAIL: $1: expected $4, got $got"; echo "$log" | grep -E 'CuMetal|high:'; fail=1; fi
}
verdict "CuMetal ${old:0:9} (before ${last:0:9}'s compiler/runtime change)" "$old" clean refused
verdict "CuMetal ${head:0:9} dirty" "$head" dirty refused
verdict "CuMetal ${head:0:9} clean" "$head" clean current
exit $fail
