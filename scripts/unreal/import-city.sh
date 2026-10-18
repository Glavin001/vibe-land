#!/usr/bin/env bash
# Import a match's city into Unreal: one Nanite static mesh per 32 m cell, with mesh distance
# fields for Lumen, keyed by the city manifest's hash (VibeCityImport commandlet). A session whose
# manifest has that hash draws its intact cells from them; others build every cell at runtime.
#
#   scripts/unreal/import-city.sh [--api http://127.0.0.1:4001] [--match citypp-demo] [--web]
#   scripts/unreal/import-city.sh --manifest <file.vlcm> [--web]
#
# --web bakes for the web textures (-VibeWebTextures) instead of the 2K sources. Build the editor
# first (scripts/unreal/build-editor.sh). The assets go to unreal/VibeCity/Content/VibeCity/Scenes/
# (generated, not committed).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
API="http://127.0.0.1:4001"
MATCH="citypp-demo"
MANIFEST=""
WEB=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --match) MATCH="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --web) WEB=(-Web); shift ;;
    *) echo "import-city: unknown argument $1" >&2; exit 2 ;;
  esac
done

OUT="$ROOT/target/unreal-import"
mkdir -p "$OUT"
if [[ -z "$MANIFEST" ]]; then
  HASH="$(curl -sf "$API/session-config?match_id=$MATCH" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("city_manifest_hash") or "")')"
  if [[ -z "$HASH" ]]; then
    echo "import-city: $MATCH has no city manifest on $API" >&2
    exit 1
  fi
  MANIFEST="$OUT/$HASH.vlcm"
  curl -sf --compressed "$API/city-manifest/$HASH" -o "$MANIFEST"
  # The commandlet keys the assets by the bytes' sha256; check they are the session's.
  [[ "$(shasum -a 256 "$MANIFEST" | cut -d' ' -f1)" == "$HASH" ]] || { echo "import-city: manifest hash mismatch" >&2; exit 1; }
fi

LOG="$OUT/import.log"
echo "import-city: $MANIFEST (log: $LOG)"
"$UE_ROOT/Engine/Binaries/Mac/UnrealEditor-Cmd" "$ROOT/unreal/VibeCity/VibeCity.uproject" \
  -run=VibeCityImport -Manifest="$MANIFEST" ${WEB[@]+"${WEB[@]}"} \
  -unattended -nop4 -nosplash -abslog="$LOG" >/dev/null 2>&1 || true
grep -E "LogVibeCityImport" "$LOG" | sed 's/.*LogVibeCityImport: //'
grep -q "imported .* 0 failed" "$LOG"
