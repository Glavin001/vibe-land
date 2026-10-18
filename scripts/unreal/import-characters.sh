#!/usr/bin/env bash
# Import the web client's character (client/public/models/UAL1_Standard.glb, Quaternius UAL, CC0)
# into VibeCity as a skeletal mesh and its animation sequences. Generated content, not committed;
# re-run after the GLB changes. Headless: runs the editor as a commandlet.
#
#   scripts/unreal/import-characters.sh
#
# Output: unreal/VibeCity/Content/VibeCity/Characters/{UAL1_Standard,Anims/<clip>}
# (see unreal/VibeCity/Scripts/import_characters.py); AVibeRemotePlayers draws other players with it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
GLB="$ROOT/client/public/models/UAL1_Standard.glb"
LOG="$ROOT/target/unreal-import-characters.log"
mkdir -p "$(dirname "$LOG")"
[[ -f "$GLB" ]] || { echo "import-characters: $GLB missing" >&2; exit 1; }

VIBE_CHARACTER_GLB="$GLB" VIBE_CHARACTER_GLB2="$ROOT/client/public/models/UAL2_Standard.glb" \
  "$UE_ROOT/Engine/Binaries/Mac/UnrealEditor-Cmd" "$ROOT/unreal/VibeCity/VibeCity.uproject" \
  -run=pythonscript -script="$ROOT/unreal/VibeCity/Scripts/import_characters.py" \
  -unattended -nop4 -nosplash -abslog="$LOG" >/dev/null 2>&1 || true
if ! grep -q "VIBE_IMPORT_OK" "$LOG"; then
  echo "import-characters: the import failed; see $LOG" >&2
  grep -E "Error|Traceback|LogPython|VIBE_IMPORTED" "$LOG" | tail -30 >&2
  exit 1
fi
grep -o "VIBE_IMPORT_OK.*" "$LOG"
