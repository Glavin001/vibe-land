#!/usr/bin/env bash
# Import the web client's destruction audio clips into VibeCity as SoundWaves (generated content,
# not committed). Headless: converts with afconvert, then runs the editor as a commandlet.
#
#   scripts/unreal/import-city-audio.sh
#
# Input: client/public/audio/destruction/*.{mp3,wav} (the clips client/public/audio/destruction/
# catalog.json names; the client core picks them by id, client-core audio.rs).
# Output: unreal/VibeCity/Content/VibeCity/Audio (see Scripts/import_city_audio.py).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
OUT="$ROOT/target/unreal-city-audio"
mkdir -p "$OUT"

count=0
for f in "$ROOT"/client/public/audio/destruction/*.mp3 "$ROOT"/client/public/audio/destruction/*.wav; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  afconvert -f WAVE -d LEI16 "$f" "$OUT/${name%.*}.wav"
  count=$((count + 1))
done
echo "import-city-audio: converted $count clips into $OUT"

LOG="$OUT/import.log"
VIBE_CITY_AUDIO="$OUT" "$UE_ROOT/Engine/Binaries/Mac/UnrealEditor-Cmd" "$ROOT/unreal/VibeCity/VibeCity.uproject" \
  -run=pythonscript -script="$ROOT/unreal/VibeCity/Scripts/import_city_audio.py" \
  -unattended -nop4 -nosplash -abslog="$LOG" >/dev/null 2>&1 || true
if ! grep -q "VIBE_AUDIO_IMPORT_OK" "$LOG"; then
  echo "import-city-audio: the import failed; see $LOG" >&2
  grep -E "Error|Traceback|LogPython|could not be found" "$LOG" | tail -20 >&2
  exit 1
fi
grep -o "VIBE_AUDIO_IMPORT_OK.*" "$LOG"
