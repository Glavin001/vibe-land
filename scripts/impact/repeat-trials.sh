#!/bin/bash
# The impact trials, repeated: identical runs of a shot can end local or in a
# collapse (the rigid simulation is not bitwise repeatable on the GPU), so one
# run proves nothing about a fix.
#   scripts/impact/repeat-trials.sh LABEL [REPEATS] [TRIALS]
# Each repeat refuses a stale SDK first (scripts/fidelity/provenance.sh on the
# garage-impact SDK), then runs each trial in its own test bed process
# (LABEL-<trial>-rK). HIGH_TRIALS_ENV carries the arm's flags; "{run}" in it
# becomes <trial>-rK (e.g. a capture directory of its own). Prints
# scripts/impact/house.py over every run: the house metrics and each trial's
# breaks by source.
# REPEAT_PROFILE=runtime: the runtime profile (scripts/fidelity/runtime.env, its
# packs) on the same SDK instead of the high one (scripts/impact/high-trials.sh).
label=${1:?usage: repeat-trials.sh LABEL [REPEATS] [TRIALS]}
repeats=${2:-3}
trials=${3:-cannonball-framed-house,meteor-framed-house,framed-house}
profile=${REPEAT_PROFILE:-high}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export IMPACT_PHYSX_ROOT=${IMPACT_PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-impact}
template=${HIGH_TRIALS_ENV:-}
runs=()
for k in $(seq 1 "$repeats"); do
  for trial in ${trials//,/ }; do
    run="$trial-r$k"
    (source "$ROOT/scripts/fidelity/$profile.env"; export PHYSX_ROOT=$IMPACT_PHYSX_ROOT; "$ROOT/scripts/fidelity/provenance.sh" "$profile") || exit 1
    export HIGH_TRIALS_ENV=${template//\{run\}/$run}
    for word in $HIGH_TRIALS_ENV; do case $word in PX_DESTRUCTION_IMPACT_CAPTURE=*) mkdir -p "${word#*=}";; esac; done
    if [ "$profile" = high ]; then
      "$ROOT/scripts/impact/high-trials.sh" "$label-$run" "$trial"
    else
      (source "$ROOT/scripts/fidelity/runtime.env"; eval "$("$ROOT/scripts/fidelity/packs.sh" runtime)"
       export PHYSX_ROOT=$IMPACT_PHYSX_ROOT
       "$ROOT/scripts/impact/trials.sh" "$label-$run" "$trial" VIBE_TESTBED_PROBE=1 \
         VIBE_CITY_SCENE="$lab" VIBE_TESTBED_META="${lab%.json}.meta.json" PX_DESTRUCTION_IMPACT_LOG=1 $HIGH_TRIALS_ENV)
    fi
    echo "$label-$run: $(tail -1 "$ROOT/target/vehicle-testbed/$label-$run.out")"
    runs+=("$ROOT/target/vehicle-testbed/$label-$run.json")
  done
done
python3 "$ROOT/scripts/impact/house.py" "${runs[@]}"
