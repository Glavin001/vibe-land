#!/bin/bash
# The vehicle test bed in one profile on its packs (high: the crush pack).
#   scripts/hifi/testbed.sh runtime|high LABEL TRIALS [ENV=VAL ...]
profile=$1 label=$2 trials=$3; shift 3
source "$(dirname "$0")/env.sh" "$profile"
export VIBE_CITY_SCENE=$lab VIBE_TESTBED_META=${lab%.json}.meta.json
cd "$HIFI_ROOT" && env "$@" scripts/vehicle-testbed.sh --build monster --trials "$trials" --label "$label" --report-only > "$HIFI_LOGS/testbed-$label.out" 2>&1
echo "testbed $label: exit $? ($HIFI_LOGS/testbed-$label.out)"
