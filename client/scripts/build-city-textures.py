#!/usr/bin/env python3
"""Bake the /city concrete texture arrays from Poly Haven sources.

The city shades every chunk through ONE material, so per-building variety has to
come from a texture array the shader indexes per instance rather than from
per-building materials. This script produces the two array sheets that back it:

  city-albedo.webp   1024 x (1024 * N)  RGBA  -- RGB = Diffuse, A = height
                                                 remapped to [128,255]: decode
                                                 (a - 0.5) * 2. Height rides
                                                 alpha for the anti-tiling
                                                 stack's detail-aware blend,
                                                 and sits in the top half of
                                                 the range because the client
                                                 decodes through a 2D canvas,
                                                 which premultiplies -- at
                                                 alpha 0.5 the RGB round-trip
                                                 loses at most one code value.
  city-surface.webp   512 x  (512 * N)  RGBA  -- R,G = nor_gl.xy
                                                 B   = roughness (arm.G)
                                                 A   = ambient occlusion (arm.R)

Both are LAYERS STACKED VERTICALLY, because a DataArrayTexture wants one
contiguous block per layer and the client slices the sheet back apart at load.
Packing normal/roughness/AO into one RGBA sheet rather than three greyscale ones
halves the fetch count in the fragment shader: the triplanar blend costs three
taps per map, so every map saved is three taps saved on every city pixel.

Sources are CC0 from Poly Haven. Outputs are committed, so an ordinary
`npm run build` never touches the network; re-run this only to change the set.

    npm run textures:city              # from client/
"""

from __future__ import annotations

import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

API = "https://api.polyhaven.com"
HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache" / "polyhaven"
OUT_DIR = HERE.parent / "public" / "textures" / "city"
OUT_TS = HERE.parent / "src" / "scene" / "cityTextureSets.generated.ts"

# Albedo carries the colour a player actually reads at distance, so it keeps the
# full 1k. The surface sheet only drives shading detail and halves cleanly.
ALBEDO_PX = 1024
SURFACE_PX = 512


@dataclass(frozen=True)
class TextureSet:
    slug: str
    # 'wall' sets land on the X/Z triplanar projections, 'floor' sets on Y. The
    # split is what keeps slab tops and rubble from wearing wall grain.
    role: str
    # Directional surfaces (formwork strata, plank lines) cannot survive the
    # stochastic rotation -- a 90-degree variant turns horizontal pour lines
    # vertical mid-wall. The shader scales its rotation by this per layer.
    directional: bool = False


# Order IS the array layer index, and walls must come first: the client derives
# a structure's wall layer by hashing into [0, wallCount) and its floor layer
# into [wallCount, total).
SETS = [
    TextureSet("cracked_concrete_wall", "wall"),
    TextureSet("worn_mossy_plasterwall", "wall"),
    TextureSet("cracked_concrete_02", "wall"),
    TextureSet("concrete_layers_02", "wall", directional=True),
    TextureSet("concrete_floor_worn_02", "floor"),
    TextureSet("concrete_floor_damaged_01", "floor"),
    # Ground layers, after walls and floors: the terrain samples these, keyed
    # by the splatmap plus a macro mask rather than by building id.
    TextureSet("leafy_grass", "ground"),
    TextureSet("brown_mud_leaves_01", "ground"),
]

# Poly Haven's own map names. `arm` is the packed AO/Roughness/Metalness map, so
# one download covers two of our four output channels.
MAPS = {"diffuse": "Diffuse", "normal": "nor_gl", "arm": "arm", "height": "Displacement"}


# Poly Haven's CDN 403s the default urllib agent.
UA = {"User-Agent": "vibe-land-city-textures/1.0 (+https://polyhaven.com)"}


def get(url: str, timeout: int) -> bytes:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url: str) -> dict:
    return json.loads(get(url, 60))


def download(url: str, dest: Path) -> Path:
    """Cached download. Re-runs are free, which matters when tuning the set."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {dest.name}")
    dest.write_bytes(get(url, 300))
    return dest


def load_maps(slug: str) -> tuple[dict[str, Image.Image], float]:
    """The three source images for one set, plus its real-world tile size."""
    files = fetch_json(f"{API}/files/{slug}")
    info = fetch_json(f"{API}/info/{slug}")

    images: dict[str, Image.Image] = {}
    for key, ph_name in MAPS.items():
        entry = files.get(ph_name)
        if not entry or "1k" not in entry or "jpg" not in entry["1k"]:
            raise SystemExit(f"{slug}: no 1k jpg for {ph_name}")
        url = entry["1k"]["jpg"]["url"]
        path = download(url, CACHE / slug / f"{key}{Path(url).suffix}")
        images[key] = Image.open(path)

    # Real-world extent in mm. These range 1000-5000 across the chosen set, so a
    # single global metres-per-tile would render them at visibly different
    # grain; the shader scales per layer instead.
    dims = info.get("dimensions") or [2000, 2000]
    return images, float(dims[0]) / 1000.0


def fit(image: Image.Image, size: int, mode: str) -> np.ndarray:
    return np.asarray(image.convert(mode).resize((size, size), Image.LANCZOS))


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    albedo = np.zeros((ALBEDO_PX * len(SETS), ALBEDO_PX, 4), dtype=np.uint8)
    surface = np.zeros((SURFACE_PX * len(SETS), SURFACE_PX, 4), dtype=np.uint8)
    metres: list[float] = []
    means: list[tuple[float, float, float]] = []

    for layer, entry in enumerate(SETS):
        print(f"[{layer}] {entry.slug} ({entry.role})")
        images, tile_m = load_maps(entry.slug)
        metres.append(tile_m)

        top = layer * ALBEDO_PX
        diffuse = fit(images["diffuse"], ALBEDO_PX, "RGB")
        albedo[top:top + ALBEDO_PX, :, :3] = diffuse
        # Height into alpha, top-half remap -- see the header.
        height = fit(images["height"], ALBEDO_PX, "L").astype(np.float32) / 255.0
        albedo[top:top + ALBEDO_PX, :, 3] = np.clip(128 + height * 127, 128, 255).astype(np.uint8)
        # Per-layer mean in LINEAR RGB, for variance-preserving blends: a
        # stochastic blend loses contrast around the mean, and restoring it
        # needs to know where the mean is.
        srgb = diffuse.astype(np.float32) / 255.0
        linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
        means.append(tuple(float(x) for x in linear.reshape(-1, 3).mean(axis=0)))

        normal = fit(images["normal"], SURFACE_PX, "RGB")
        arm = fit(images["arm"], SURFACE_PX, "RGB")
        top = layer * SURFACE_PX
        # Blue is dropped from the normal: for a unit tangent-space normal it is
        # recoverable as sqrt(1 - x^2 - y^2), and the freed channel is what lets
        # roughness and AO ride along in the same fetch.
        surface[top:top + SURFACE_PX, :, 0] = normal[:, :, 0]
        surface[top:top + SURFACE_PX, :, 1] = normal[:, :, 1]
        surface[top:top + SURFACE_PX, :, 2] = arm[:, :, 1]
        surface[top:top + SURFACE_PX, :, 3] = arm[:, :, 0]

    albedo_path = OUT_DIR / "city-albedo.webp"
    surface_path = OUT_DIR / "city-surface.webp"
    # Albedo tolerates lossy: it is multiplied by lighting and viewed at a
    # distance. The surface sheet does not -- webp's chroma handling smears
    # normal XY into each other, which reads as shimmering facets under a moving
    # light, so it stays lossless.
    Image.fromarray(albedo, "RGBA").save(albedo_path, "WEBP", quality=90, method=6)
    Image.fromarray(surface, "RGBA").save(surface_path, "WEBP", lossless=True, method=6)

    layers = "\n".join(
        f"  {{ slug: '{e.slug}', role: '{e.role}', metresPerTile: {m:.3f}, "
        f"directional: {'true' if e.directional else 'false'}, "
        f"meanLinear: [{mean[0]:.4f}, {mean[1]:.4f}, {mean[2]:.4f}] }},"
        for e, m, mean in zip(SETS, metres, means)
    )
    OUT_TS.write_text(
        "// GENERATED by client/scripts/build-city-textures.py -- do not edit.\n"
        "//\n"
        "// Layer index is the array layer in city-albedo.webp / city-surface.webp.\n"
        "// Walls come first, then floors; `cityTextures.ts` relies on that order.\n"
        "\n"
        "export type CityTextureRole = 'wall' | 'floor' | 'ground';\n"
        "\n"
        "export interface CityTextureSet {\n"
        "  slug: string;\n"
        "  role: CityTextureRole;\n"
        "  /** Real-world extent of one tile, from Poly Haven's own metadata. */\n"
        "  metresPerTile: number;\n"
        "  /** Strata/plank surfaces that cannot survive stochastic rotation. */\n"
        "  directional: boolean;\n"
        "  /** Mean albedo in linear RGB, for variance-preserving blends. */\n"
        "  meanLinear: [number, number, number];\n"
        "}\n"
        "\n"
        "export const CITY_TEXTURE_SETS: readonly CityTextureSet[] = [\n"
        f"{layers}\n"
        "];\n"
        "\n"
        f"export const CITY_ALBEDO_PX = {ALBEDO_PX};\n"
        f"export const CITY_SURFACE_PX = {SURFACE_PX};\n",
    )

    for path in (albedo_path, surface_path):
        print(f"wrote {path.relative_to(HERE.parent)}  {path.stat().st_size / 1024:.0f} KiB")
    print(f"wrote {OUT_TS.relative_to(HERE.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
