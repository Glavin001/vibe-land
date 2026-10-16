#!/bin/bash
# The verification harness's own regressions (2026-10-08), each a bug that
# made a result mean nothing without failing anything:
#  1. ctest rows pass on "No tests were found" (mohr-coulomb-graders passed while
#     its test did not exist): every ctest command carries --no-tests=error.
#  2. Regressions ran on a retired SDK (correctness.sh hard-coded garage-hifi
#     after high.env moved): no SDK install path in regressions.tsv (the runner's
#     $RUNTIME_SDK / $ROTATION_SDK / $CRUSH_SDK only), and the single-feature
#     SDKs default to high.env's own PHYSX_ROOT.
#  3. The native app ran the high profile's engine flags on the runtime packs
#     (2,719 lab bonds broken at rest): under high.env every scene with a high
#     pack resolves to it, and without it to the runtime pack.
#  4. The native app hung WindowServer: its defaults turn off CuMetal's keep-alive
#     and its resident cooperative grids (cross-threadgroup spin barriers, which
#     deadlock the GPU when the window server holds cores).
# Exit 1 on any violation, with each one named. CPU only, no GPU, no launch.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
bad=0
fail() { echo "lint-harness: $*"; bad=1; }

# 1. ctest rows.
while IFS=$'\t' read -r id tier profile what cmd; do
  [[ -z "$id" || "$id" == \#* ]] && continue
  [[ "$cmd" == \(* ]] && continue  # recorded, not run
  if [[ "$cmd" == *ctest* && "$cmd" != *--no-tests=error* ]]; then fail "$id: ctest without --no-tests=error"; fi
  if [[ "$cmd" =~ /out/install/[a-z] ]]; then fail "$id: an SDK install path in its command (use \$RUNTIME_SDK, \$ROTATION_SDK or \$CRUSH_SDK)"; fi
done < scripts/verify/regressions.tsv

# 2. The single-feature SDKs follow high.env.
high_sdk=$(env -u HIGH_PHYSX_ROOT bash -c 'source scripts/fidelity/high.env >/dev/null 2>&1; echo "$PHYSX_ROOT"')
for var in ROTATION_SDK CRUSH_SDK; do
  line=$(grep -E "^export $var=" scripts/verify/correctness.sh)
  [[ "$line" == *'$HIGH_ENV_SDK'* ]] || fail "correctness.sh: $var does not default to high.env's SDK ($line)"
done
[ -n "$high_sdk" ] || fail "high.env sets no PHYSX_ROOT"

# 3. The native app's packs follow the profile.
packs=$(scripts/fidelity/packs.sh high)
for scene in lab town; do
  key=$scene
  want_high=$(echo "$packs" | sed -n "s/^$key=//p")
  got_high=$(env -u VEHICLE_LAB_PACK -u VIBE_TOWN_PACK bash -c 'source scripts/fidelity/high.env >/dev/null 2>&1; MYSTRAL_ROOT=/nonexistent scripts/native-mac.sh scene-env --scene '"$scene" 2>/dev/null | tail -1)
  got_runtime=$(env -u VIBE_FIDELITY -u VEHICLE_LAB_PACK -u VIBE_TOWN_PACK MYSTRAL_ROOT=/nonexistent scripts/native-mac.sh scene-env --scene "$scene" 2>/dev/null | tail -1)
  [ "$got_high" = "$want_high" ] || fail "native-mac.sh --scene $scene under high.env runs $got_high, not the high pack $want_high"
  case "$got_runtime" in
    "$ROOT"/structures/*) ;;
    *) fail "native-mac.sh --scene $scene without a profile runs $got_runtime, not a runtime pack" ;;
  esac
done

# 4. The native app lets the GPU idle: no CuMetal keep-alive in its defaults
#    (the 250 us heartbeat hung WindowServer 52-68 s after launch, 4 of 4 runs).
for key in CUMETAL_GPU_KEEPALIVE_US CUMETAL_GPU_KEEPALIVE_BUSY CUMETAL_COOPERATIVE_RESIDENT_GRID; do
  grep -qE "\(\"$key\", \"0\"\)" sim-native/src/city.rs || fail "sim-native apply_app_defaults does not set $key to 0 (the app must not keep the GPU awake or wait across threadgroups)"
done

[ "$bad" = 0 ] && echo "lint-harness: ctest rows, SDK paths, regression SDKs, the app's packs and its GPU keep-alive: ok"
exit $bad
