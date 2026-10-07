#!/bin/bash
# The veneer-house trials filmed one take each (every take starts from a
# standing house; in one take the first hit leaves the rest nothing to hit).
#   scripts/hifi/film-houses.sh runtime|high NOTE [TRIALS]
# Appends "trial video" lines to target/hifi-logs/films-PROFILE.txt.
profile=$1 note=$2
trials=${3:-framed-house,framed-house-corner,cannonball-framed-house,meteor-framed-house,smallshots-framed-house}
here=$(cd "$(dirname "$0")" && pwd)
for t in ${trials//,/ }; do
  # The small shots are 100 kg balls of the cannonball's steel (trials.mjs);
  # the native film replays the game's cannonball, so it takes their mass.
  mass=(); [ "$t" = smallshots-framed-house ] && mass=(env VIBE_CITY_BALL_MASS_KG=100)
  ${mass[@]+"${mass[@]}"} "$here/film-lab.sh" "$profile" "$t" "$note"
  log=$(ls -t "$here/../../target/native-video"/vehicle-lab-*.log | head -1)
  video=${log%.log}-final.mp4
  echo "$t $([ -f "$video" ] && echo "$video" || echo "FAILED $log")" >> "$here/../../target/hifi-logs/films-$profile.txt"
done
