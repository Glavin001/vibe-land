#!/bin/bash
# The high-profile impact trials, repeated: identical runs of a shot can end
# local or in a collapse (the rigid simulation is not bitwise repeatable on the
# GPU), so one run proves nothing about a fix.
#   scripts/impact/repeat-trials.sh LABEL [REPEATS] [TRIALS]
# Each repeat refuses a stale SDK first (scripts/fidelity/provenance.sh high on
# the garage-impact SDK), then runs scripts/impact/high-trials.sh LABEL-rK;
# HIGH_TRIALS_ENV carries the arm's flags. Prints scripts/impact/house.py over
# every repeat: the house metrics and each trial's breaks by source.
label=${1:?usage: repeat-trials.sh LABEL [REPEATS] [TRIALS]}
repeats=${2:-3}
trials=${3:-cannonball-framed-house,meteor-framed-house,framed-house}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export IMPACT_PHYSX_ROOT=${IMPACT_PHYSX_ROOT:-$(cd "$ROOT/.." && pwd)/PhysX/out/install/garage-impact}
for k in $(seq 1 "$repeats"); do
  (source "$ROOT/scripts/fidelity/high.env"; export PHYSX_ROOT=$IMPACT_PHYSX_ROOT; "$ROOT/scripts/fidelity/provenance.sh" high) || exit 1
  "$ROOT/scripts/impact/high-trials.sh" "$label-r$k" "$trials"
  tail -1 "$ROOT/target/vehicle-testbed/$label-r$k.out"
done
python3 "$ROOT/scripts/impact/house.py" $(for k in $(seq 1 "$repeats"); do echo "$ROOT/target/vehicle-testbed/$label-r$k.json"; done)
