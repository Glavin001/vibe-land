#!/bin/bash
# The cannonball (or another trial) on the high-fidelity packs, adding the
# high profile's flags one group at a time:
#   scripts/impact/bisect-high.sh [TRIAL] [PACK_DIR]
# PACK_DIR: a high build of structures/vehicle-lab/out (scripts/fidelity/build-packs.sh high).
# Writes target/vehicle-testbed/bisect-<step>-TRIAL.{out,json,log}; prints a line per step.
trial=${1:-cannonball-framed-house}
H=${2:-$(cd "$(dirname "$0")/../.." && pwd)/.claude/worktrees/hifi/target/fidelity/high/structures/vehicle-lab/out}
cd "$(dirname "$0")/../.."
pack=(VIBE_CITY_SCENE=$H/vehicle-lab-crush.json VIBE_TESTBED_META=$H/vehicle-lab-crush.meta.json)
steps=(
  "1-impact|VIBE_IMPACT_CAPACITY=1"
  "2-sections|VIBE_IMPACT_CAPACITY=1 VIBE_SECTION_BENDING=1 VIBE_SECTION_ROTATION=1"
  "3-stiffness|VIBE_IMPACT_CAPACITY=1 VIBE_SECTION_BENDING=1 VIBE_SECTION_ROTATION=1 VIBE_BOND_TRUE_STIFFNESS=1 VIBE_BOND_CONTACT_LENGTH=1"
  "4-shortterm|VIBE_IMPACT_CAPACITY=1 VIBE_SECTION_BENDING=1 VIBE_SECTION_ROTATION=1 VIBE_BOND_TRUE_STIFFNESS=1 VIBE_BOND_CONTACT_LENGTH=1 VIBE_STRENGTH_SHORT_TERM=1"
  "5-crush|VIBE_IMPACT_CAPACITY=1 VIBE_SECTION_BENDING=1 VIBE_SECTION_ROTATION=1 VIBE_BOND_TRUE_STIFFNESS=1 VIBE_BOND_CONTACT_LENGTH=1 VIBE_STRENGTH_SHORT_TERM=1 VIBE_NATIVE_CRUSH=1 VIBE_CRUSH_CONSERVE_MASS=1"
  "6-full|VIBE_IMPACT_CAPACITY=1 VIBE_SECTION_BENDING=1 VIBE_SECTION_ROTATION=1 VIBE_BOND_TRUE_STIFFNESS=1 VIBE_BOND_CONTACT_LENGTH=1 VIBE_STRENGTH_SHORT_TERM=1 VIBE_NATIVE_CRUSH=1 VIBE_CRUSH_CONSERVE_MASS=1 VIBE_NATIVE_UNCAPPED_SPIN=1 VIBE_NATIVE_STRESS_FORCE_TOLERANCE=1e-3 VIBE_PLAYER_SNAP_TO_GROUND=1"
)
for s in "${@:3}"; do :; done
for step in "${steps[@]}"; do
  name=${step%%|*}; flags=${step#*|}
  [ -n "$BISECT_ONLY" ] && [[ " $BISECT_ONLY " != *" $name "* ]] && continue
  scripts/impact/trials.sh bisect-$name-$trial $trial "${pack[@]}" $flags PX_DESTRUCTION_IMPACT_LOG=1
  printf '%s: ' "$name"; python3 scripts/impact/house.py target/vehicle-testbed/bisect-$name-$trial.json | tail -n +2 | tr '\n' ' '; echo
done
