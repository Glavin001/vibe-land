#!/bin/bash
# The held-meteor regression: wall-matrix meteors on the test bed in the high
# profile (one case per process), each judged on its momentum floor from the
# pack (scripts/verify/momentum-floor.mjs). Exit 1 when one leaves slower.
#   scripts/verify/meteor-floor.sh [OUTDIR] [CASES]
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
out=${1:-$ROOT/target/verify/meteor-floor}
cases=${2:-wm-stone-house-upper-meteor-0,wm-masonry-meteor-0}
rm -rf "$out"
"$ROOT/scripts/verify/scenario-repeats.sh" --arms high --repeats 1 --cases "$cases" "$out" > "$out.log" 2>&1
eval "$("$ROOT/scripts/fidelity/packs.sh" high)"
runs=(); for c in ${cases//,/ }; do [ -f "$out/high/r1/$c.json" ] && runs+=("$out/high/r1/$c.json") || { echo "FAIL  $c: no report ($out.log)"; exit 1; }; done
node "$ROOT/scripts/verify/momentum-floor.mjs" --pack "$lab" --meta "$out/high/lab.meta.json" "${runs[@]}"
