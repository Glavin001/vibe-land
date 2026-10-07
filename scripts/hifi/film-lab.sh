#!/bin/bash
# Vehicle-lab trials filmed in the native app, in one profile on its packs.
#   scripts/hifi/film-lab.sh runtime|high TRIALS NOTE
profile=$1 trials=$2 note=$3
source "$(dirname "$0")/env.sh" "$profile"
export VEHICLE_LAB_PACK=${lab%.json} VEHICLE_LAB_TRIALS=$trials FILM_CHECK=${FILM_CHECK:-0} VEHICLE_LAB_NOTE="$note"
cd "$HIFI_ROOT" && scripts/native-mac.sh vehicle-lab --build monster > "$HIFI_LOGS/film-lab-$profile.out" 2>&1
echo "film-lab $profile: exit $? ($HIFI_LOGS/film-lab-$profile.out)"
