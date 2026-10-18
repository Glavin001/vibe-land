#!/bin/bash
# The scene packs of an engine profile, as KEY=path lines:
#   lab     the vehicle lab        veneer  the veneer houses dir     town  Vibe Town
# runtime: the default outputs; high: the isolated high-fidelity build
# (scripts/fidelity/build-packs.sh high), crush and real-capacity variants.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
case ${1:?usage: packs.sh runtime|high} in
  runtime)
    echo "lab=$ROOT/structures/vehicle-lab/out/vehicle-lab.json"
    echo "veneer=$ROOT/structures/town-kit/out/veneer-houses"
    echo "town=$ROOT/structures/vibe-town/out/vibe-town.json" ;;
  high)
    b=${FIDELITY_PACK_DIR:-$ROOT/target/fidelity/high}/structures
    echo "lab=$b/vehicle-lab/out/vehicle-lab-crush.json"
    echo "veneer=$b/town-kit/out/veneer-houses-crush"
    echo "town=$b/vibe-town/out/vibe-town-crush-real.json" ;;
esac
