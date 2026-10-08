#!/bin/bash
# The anisotropic joint stiffness on the GPU's multilevel path (a component past
# the block solver's 8192 nodes) against the FP64 oracle: scripts/verify/shear-stiffness-beam.py.
# Needs the high profile's SDK with PX_DESTRUCTION_SHEAR_STIFFNESS (HIGH_PHYSX_ROOT).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
out=${1:-$ROOT/target/verify/shear-stiffness-beam}; mkdir -p "$out"
python3 "$ROOT/scripts/verify/shear-stiffness-beam.py" make "$out/beam.json"
( source "$ROOT/scripts/fidelity/high.env"
  VIBE_SHEAR_STIFFNESS=1 VIBE_GPU_SHARED=1 VIBE_CITY_NATIVE_STRESS_ITERATIONS=4096 VIBE_QUALIFY_BOND_ROWS="$out/rows.json" \
    python3 "$ROOT/scripts/perf/qualify_structures.py" "$out/beam.json" --ticks 5 --json "$out/qualify.json" > "$out/qualify.log" 2>&1 || true )
uv run -q --with numpy --with scipy python "$ROOT/scripts/verify/shear-stiffness-beam.py" compare "$out/beam.json" "$out/rows.json"
