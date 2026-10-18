#!/usr/bin/env bash
# Build VibeCity's city materials (texture arrays + PBR materials) from the web client's texture
# sheets and the shared material catalog. Generated content, not committed; re-run after either
# input changes. Headless: runs the editor as a commandlet.
#
#   scripts/unreal/import-city-materials.sh [--hd]
#
# --hd also builds M_VibeCityChunkHD from each layer's higher-resolution source (catalog `hd`: 2K
# Poly Haven albedo, DirectX normal and AO/roughness/metal maps, CC0), fetched once into
# target/polyhaven-2k (about 8 MB a layer) by the same API the web's texture build uses
# (client/scripts/build-city-textures.py). The renderer prefers it when present.
#
# Inputs: client/public/textures/city/city-{albedo,surface}.webp (vertical layer stacks: albedo
# 1024 px, surface 512 px per layer), shared/assets/materials/catalog.json.
# Output: unreal/VibeCity/Content/VibeCity/{Textures,Materials} (see Scripts/import_city_materials.py).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UE_ROOT="${UE_ROOT:-/Users/Shared/Epic Games/UE_5.8}"
OUT="$ROOT/target/unreal-city-textures"
SHEETS="$ROOT/client/public/textures/city"
CATALOG="$ROOT/shared/assets/materials/catalog.json"
mkdir -p "$OUT"
HD=0
[[ "${1:-}" == "--hd" ]] && HD=1

# Layer count: the catalog entries that have a texture-array layer.
LAYERS=$(python3 -c "import json,sys; print(sum(1 for m in json.load(open(sys.argv[1]))['materials'] if m.get('layer') is not None))" "$CATALOG")

# webp -> png once, then cut each layer out of the stack (sips reads webp on macOS 11+).
cut() { # cut <sheet> <kind> <px>
  local sheet="$1" kind="$2" px="$3"
  sips -s format png "$SHEETS/$sheet" --out "$OUT/$kind-sheet.png" >/dev/null
  local height; height=$(sips -g pixelHeight "$OUT/$kind-sheet.png" | awk '/pixelHeight/ {print $2}')
  if (( height != px * LAYERS )); then
    echo "import-city-materials: $sheet is $height px tall; the catalog's $LAYERS layers need $((px * LAYERS))" >&2
    exit 1
  fi
  for ((i = 0; i < LAYERS; i++)); do
    sips -c "$px" "$px" --cropOffset $((i * px)) 0 "$OUT/$kind-sheet.png" --out "$(printf '%s/%s_%02d.png' "$OUT" "$kind" "$i")" >/dev/null
  done
}
cut city-albedo.webp albedo 1024
cut city-surface.webp surface 512
echo "import-city-materials: cut $LAYERS layers into $OUT"

HD_DIR="$ROOT/target/polyhaven-2k"
if [[ "$HD" == 1 ]]; then
  # Poly Haven's CDN refuses the default agents (as build-city-textures.py notes).
  python3 - "$CATALOG" "$HD_DIR" <<'PY'
import json, os, sys, urllib.request
catalog, out = sys.argv[1], sys.argv[2]
UA = {"User-Agent": "vibe-land-city-textures/1.0 (+https://polyhaven.com)"}
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return r.read()
for m in json.load(open(catalog))["materials"]:
    if m.get("layer") is None:
        continue
    slug = m["hd"]["polyHaven"]
    files = json.loads(get(f"https://api.polyhaven.com/files/{slug}"))
    for key, name in (("albedo", "Diffuse"), ("normal", "nor_dx"), ("arm", "arm")):
        dest = os.path.join(out, f"{key}_{m['layer']:02d}.jpg")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            continue
        os.makedirs(out, exist_ok=True)
        url = files[name]["2k"]["jpg"]["url"]
        print(f"  fetching {slug} {name}")
        open(dest, "wb").write(get(url))
PY
  echo "import-city-materials: 2K sources in $HD_DIR"
fi

LOG="$OUT/import.log"
HD_ENV=""
if [[ "$HD" == 1 ]]; then HD_ENV="$HD_DIR"; fi
VIBE_CITY_TEXTURES="$OUT" VIBE_MATERIAL_CATALOG="$CATALOG" VIBE_CITY_HD_TEXTURES="$HD_ENV" \
  "$UE_ROOT/Engine/Binaries/Mac/UnrealEditor-Cmd" "$ROOT/unreal/VibeCity/VibeCity.uproject" \
  -run=pythonscript -script="$ROOT/unreal/VibeCity/Scripts/import_city_materials.py" \
  -unattended -nop4 -nosplash -abslog="$LOG" >/dev/null 2>&1 || true
if ! grep -q "VIBE_IMPORT_OK" "$LOG"; then
  echo "import-city-materials: the import failed; see $LOG" >&2
  grep -E "Error|Traceback|LogPython" "$LOG" | tail -20 >&2
  exit 1
fi
grep -o "VIBE_IMPORT_OK.*" "$LOG"
