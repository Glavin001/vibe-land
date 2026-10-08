#!/bin/bash
# The infinite_wall tests in the high profile (high.env: the explicit impact
# step and the handoff flags) on the high SDK, resolved to one revision.
# Regression infinite-wall-high (scripts/verify/regressions.tsv).
{
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT" || exit 1
source scripts/fidelity/high.env
export PHYSX_ROOT=$(cd -P "$PHYSX_ROOT" && pwd) VIBE_GPU_SHARED=1 CARGO_TARGET_DIR=target/verify-garage-clean
cargo test -q -p vibe-land-physx-bridge --features native-destruction --test infinite_wall -- --ignored --test-threads=1 --exact \
  layered_wall load_moves_in_the_corrected_pass impact_pulse heavy_impactor_anchored_wall fragment_depenetration_cap
exit
}
