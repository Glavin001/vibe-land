#!/bin/bash
# The scenario-outcome matrix (docs/verification/SCENARIOS.md) for one engine
# profile: build the scenario cases (scripts/verify/scenarios.mjs meta), run
# them on the test bed (lab with the monster truck, the fleet cars, Vibe Town),
# then judge them against the real-world expectations.
#
#   scripts/verify/scenarios.sh runtime|high [--only lab,fleet,town] [--judge-only]
#
# One GPU job at a time, a shared slot (VIBE_GPU_SHARED=1, scripts/perf/gpu-run.sh).
# Writes target/verify/scenarios-PROFILE/{lab,fleet,town}.json and
# scenarios.json (the verdict rows); exit 1 when a check fails.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
profile=${1:?usage: scenarios.sh runtime|high [--only lab,fleet,town] [--judge-only]}; shift
only="lab,fleet,town" judge_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) only="$2"; shift 2 ;;
    --judge-only) judge_only=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
out="$ROOT/target/verify/scenarios-$profile"; mkdir -p "$out"
case $profile in
  runtime) source "$ROOT/scripts/fidelity/runtime.env"; node "$ROOT/structures/vehicle-lab/build-lab.mjs" > /dev/null ;;
  high) export HIGH_PHYSX_ROOT=${HIGH_PHYSX_ROOT:-/Users/glavin/Development/PhysX/out/install/garage-hifi}
        source "$ROOT/scripts/fidelity/high.env" ;;
  *) echo "profile runtime|high" >&2; exit 2 ;;
esac
source "$ROOT/scripts/fidelity/check.sh" --degrade
"$ROOT/scripts/fidelity/provenance.sh" "$profile" | tee "$out/provenance.log" || { echo "[scenarios] refused: see $out/provenance.log"; exit 1; }
eval "$("$ROOT/scripts/fidelity/packs.sh" "$profile")"
want() { [[ ",$only," == *",$1,"* ]]; }
if [ "$judge_only" = 0 ]; then
  node "$ROOT/scripts/verify/scenarios.mjs" meta lab --pack "$lab" --base "${lab%.json}.meta.json" --out "$out/lab.meta.json"
  node "$ROOT/scripts/verify/scenarios.mjs" meta town --pack "$town" --base "${lab%.json}.meta.json" --out "$out/town.meta.json"
  sdk=$(basename "$PHYSX_ROOT")
  export CARGO_TARGET_DIR=$ROOT/target/verify-server-$sdk
  build=$(cd "$ROOT" && cargo test --release -p web-fps-server --features native-destruction --lib --no-run 2>&1) || { echo "$build" | grep -E '^error' -A12; exit 1; }
  bin=$(echo "$build" | sed -n 's/.*Executable unittests src\/lib.rs (\(.*\))/\1/p' | tail -1)
  export VIBE_GPU_SHARED=1 VIBE_TESTBED_PROBE=1 CUMETAL_CACHE_DIR="$ROOT/target/cumetal-cache-scenarios"
  GPU_RUN=/Users/glavin/Development/vibe-land/scripts/perf/gpu-run.sh
  run() { # name scene-pack meta cars trials [env...]
    local name=$1 pack=$2 meta=$3 cars=$4 trials=$5; shift 5
    local ids; ids=$(echo "$trials" | tr ',' '\n' | sed 's/$/$/' | paste -sd, -)
    echo "[scenarios] $profile $name: $cars x $(echo "$trials" | tr ',' '\n' | wc -l | tr -d ' ') cases"
    (cd "$ROOT" && env "$@" VIBE_CITY_SCENE="$pack" VIBE_TESTBED_META="$meta" VIBE_TESTBED_CARS="$cars" VIBE_TESTBED_TRIALS="$ids" \
      VIBE_TESTBED_LABEL="scen-$profile-$name" "$GPU_RUN" "scen-$profile-$name" "$ROOT/$bin" vehicle_testbed --ignored --nocapture --test-threads=1) \
      > "$out/$name.log" 2>&1 || echo "[scenarios] $name: test bed exited non-zero (see $out/$name.log)"
    cp "$ROOT/target/vehicle-testbed/scen-$profile-$name.json" "$out/$name.json" 2>/dev/null || echo "[scenarios] $name: no report"
  }
  want lab && run lab "$lab" "$out/lab.meta.json" monster "$(node "$ROOT/scripts/verify/scenarios.mjs" trials lab)" VIBE_TESTBED_SCENE=lab
  want fleet && run fleet "$lab" "$out/lab.meta.json" "$(node -e "console.log(require('$ROOT/scripts/verify/scenarios.json').fleet.cars.join(','))")" "$(node "$ROOT/scripts/verify/scenarios.mjs" trials fleet)" VIBE_TESTBED_SCENE=lab
  want town && run town "$town" "$out/town.meta.json" monster "$(node "$ROOT/scripts/verify/scenarios.mjs" trials town)" VIBE_TESTBED_SCENE=town
fi
# extra-*.json: reruns of single cases (later runs of a case override earlier ones).
reports=(); for n in lab fleet town; do [ -f "$out/$n.json" ] && reports+=("$out/$n.json"); done
for f in "$out"/extra-*.json; do [ -f "$f" ] && reports+=("$f"); done
node "$ROOT/scripts/verify/scenarios.mjs" judge "$profile" --lab "$lab" --town "$town" --out "$out/scenarios.json" "${reports[@]}" | tee "$out/verdict.txt"
exit "${PIPESTATUS[0]}"
