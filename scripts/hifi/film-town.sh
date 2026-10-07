#!/bin/bash
# The Vibe Town showcase (films/hifi-showcase.mjs) in one profile on its town pack.
#   scripts/hifi/film-town.sh runtime|high NOTE
profile=$1 note=$2
source "$(dirname "$0")/env.sh" "$profile"
export TOWN_PACK=${town%.json} FILM_FPS=${FILM_FPS:-60} FILM_DEFINES="--define:HIFI_NOTE=\"${note// /_}\""
cd "$HIFI_ROOT" && scripts/native-mac.sh film hifi-showcase --scene town > "$HIFI_LOGS/film-town-$profile.out" 2>&1
echo "film-town $profile: exit $? ($HIFI_LOGS/film-town-$profile.out)"
