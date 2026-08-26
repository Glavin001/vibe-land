// The city's concrete: two array textures, and which layer a building gets.
//
// Every city chunk draws from ONE material (see cityChunkMesh), so per-building
// variety cannot come from per-building materials -- it has to come from a
// texture array that the shader indexes per instance. That is what this module
// owns: a DataArrayTexture of albedo, a second of packed surface detail, and
// the hash that decides which layers a structure uses.
//
// The arrays are allocated at full size and filled with neutral concrete BEFORE
// the sheets arrive, so the material can be built synchronously and the city
// never flashes untextured-then-textured mid-build. Loading writes into the
// same buffers in place and flips needsUpdate. This also sidesteps three
// handing texSubImage3D a null view, which is an INVALID_VALUE.
//
// Module-level and never disposed: the city mesh is torn down and rebuilt on
// pattern-pool changes, and re-decoding 30 MB of concrete each time would make
// that toggle feel like a level reload.

import * as THREE from 'three';

import {
  CITY_ALBEDO_PX,
  CITY_SURFACE_PX,
  CITY_TEXTURE_SETS,
} from './cityTextureSets.generated';


/** Layers, in sheet order: walls first, then floors. */
export const CITY_TEX_LAYERS = CITY_TEXTURE_SETS.length;

/**
 * Walls occupy [0, WALL_LAYER_COUNT), floors the rest.
 *
 * Derived rather than hardcoded, but it does assume the generator kept walls
 * first -- which it documents and which `layerCodeForStructure` depends on.
 */
export const WALL_LAYER_COUNT = CITY_TEXTURE_SETS.filter((set) => set.role === 'wall').length;
export const FLOOR_LAYER_COUNT = CITY_TEX_LAYERS - WALL_LAYER_COUNT;

/**
 * Radix used to pack a wall layer and a floor layer into one float.
 *
 * The anchor already spends its w component on the layer, and adding a second
 * per-instance float to carry the floor layer would cost 4 bytes on every one
 * of ~41k instances to move information that fits in the exponent-free part of
 * a float we are already sending. 16 is comfortably above any plausible layer
 * count and keeps the packed value exactly representable.
 */
export const LAYER_CODE_RADIX = 16;

/** Metres of world covered by one tile of each layer, for the shader's scale. */
export const CITY_TEX_METRES: Float32Array = Float32Array.from(
  CITY_TEXTURE_SETS.map((set) => set.metresPerTile),
);

/** Per-layer mean albedo (linear RGB), for variance-preserving blends. */
export const CITY_TEX_MEANS: Float32Array = Float32Array.from(
  CITY_TEXTURE_SETS.flatMap((set) => set.meanLinear),
);

/**
 * Per-layer rotation allowance for the stochastic retiling. 0 for directional
 * surfaces: rotating formwork strata turns horizontal pour lines vertical
 * mid-wall, which reads as broken, not varied.
 */
export const CITY_TEX_ROTATION: Float32Array = Float32Array.from(
  CITY_TEXTURE_SETS.map((set) => (set.directional ? 0 : 1)),
);

export interface CityTextureArrays {
  albedo: THREE.DataArrayTexture;
  /** R,G = normal.xy  B = roughness  A = ambient occlusion. */
  surface: THREE.DataArrayTexture;
}

/**
 * Building id -> packed (wall layer, floor layer).
 *
 * Ids are slot numbers of a building's root chunk, which are dense and locally
 * consecutive -- so a plain modulo would walk the layers in lockstep with the
 * street grid and stripe the city. This is the murmur3 finaliser, which
 * decorrelates consecutive inputs, and it is a pure function of the id so a
 * rebuild picks the same concrete.
 */
export function layerCodeForBuilding(buildingId: number): number {
  let h = buildingId >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35) >>> 0;
  // The unsigned coercion is not decoration: `^=` yields a SIGNED 32-bit int,
  // and a negative hash makes `%` negative, which packs a layer code that
  // decodes to a wall index of -1.
  h = (h ^ (h >>> 16)) >>> 0;
  const wall = h % WALL_LAYER_COUNT;
  const floor = WALL_LAYER_COUNT + ((h >>> 8) % FLOOR_LAYER_COUNT);
  return wall + LAYER_CODE_RADIX * floor;
}

function buildArray(
  size: number,
  fill: readonly [number, number, number, number],
  colorSpace: string,
  anisotropy: number,
): THREE.DataArrayTexture {
  const data = new Uint8Array(size * size * 4 * CITY_TEX_LAYERS);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  const texture = new THREE.DataArrayTexture(data, size, size, CITY_TEX_LAYERS);
  // DataArrayTexture's defaults are hostile to this use: Nearest filtering and
  // no mipmaps, which on a tiled surface viewed at city scale is pure aliasing.
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // The whole point is tiling, and the default is ClampToEdge.
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.colorSpace = colorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Tileable value-noise for the macro variation field, generated at startup.
 *
 * The macro field is what breaks "this whole building is one material": a
 * low-frequency world-space modulation of albedo, roughness and normal
 * response. Three octave bands of this one texture, sampled at different
 * scales and rotations, cost three taps of a 256^2 texture that lives in
 * cache -- far cheaper than the ALU of computing the noise per fragment.
 */
export function cityMacroNoise(): THREE.DataTexture {
  if (macroNoise) return macroNoise;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const fractOf = (x: number) => x - Math.floor(x);
  const hash = (x: number, y: number, seed: number) =>
    fractOf(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, period: number, seed: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const wrap = (v: number) => ((v % period) + period) % period;
    const a = hash(wrap(ix), wrap(iy), seed);
    const b = hash(wrap(ix + 1), wrap(iy), seed);
    const c = hash(wrap(ix), wrap(iy + 1), seed);
    const d = hash(wrap(ix + 1), wrap(iy + 1), seed);
    const ux = smooth(x - ix);
    const uy = smooth(y - iy);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let sum = 0;
      let amp = 0.5;
      let norm = 0;
      for (let octave = 0; octave < 4; octave += 1) {
        const period = 3 << octave;
        sum += amp * noise(u * period, v * period, period, 55.2 + octave * 17.31);
        norm += amp;
        amp *= 0.5;
      }
      const q = Math.round(Math.min(1, Math.max(0, sum / norm)) * 255);
      const i = (y * size + x) * 4;
      data[i] = q;
      data[i + 1] = q;
      data[i + 2] = q;
      data[i + 3] = 255;
    }
  }
  macroNoise = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  macroNoise.colorSpace = THREE.NoColorSpace;
  macroNoise.wrapS = THREE.RepeatWrapping;
  macroNoise.wrapT = THREE.RepeatWrapping;
  macroNoise.generateMipmaps = true;
  macroNoise.minFilter = THREE.LinearMipmapLinearFilter;
  macroNoise.magFilter = THREE.LinearFilter;
  macroNoise.needsUpdate = true;
  return macroNoise;
}

let macroNoise: THREE.DataTexture | null = null;
let arrays: CityTextureArrays | null = null;
let loadStarted = false;

/**
 * Anisotropic filtering on the albedo array. Live, for the perf sweep.
 *
 * The M3 report's strongest anomaly: dropping the surface taps saved ~0 ms
 * while dropping ALL city texturing saved 2.6 ms GPU -- so the cost is in the
 * three albedo taps, and the one thing the albedo array has that the (cheap)
 * surface array does not is anisotropy 4. This knob exists to test exactly
 * that, on the machine where it costs something. Changing it re-uploads the
 * array (needsUpdate), which is why the sweep gives the step a warm-up.
 */
export function cityTextureAnisotropy(): number {
  return arrays?.albedo.anisotropy ?? 4;
}

export function setCityTextureAnisotropy(next: number): void {
  if (!arrays || !Number.isFinite(next) || next < 1) return;
  if (arrays.albedo.anisotropy === next) return;
  arrays.albedo.anisotropy = next;
  arrays.albedo.needsUpdate = true;
}

/**
 * The city's texture arrays, neutral until the sheets land.
 *
 * Safe to call before or after the load resolves, and safe to call every build.
 */
export function cityTextures(): CityTextureArrays {
  if (!arrays) {
    arrays = {
      // Mid grey at roughly the lightness the old flat chunks had, so a failed
      // fetch degrades to today's look rather than to black. Alpha carries
      // HEIGHT (top-half remapped; see the bake script), so the neutral fill is
      // mid-height 191, not opaque 255.
      albedo: buildArray(
        CITY_ALBEDO_PX,
        [158, 158, 158, 191],
        THREE.SRGBColorSpace,
        4,
      ),
      // Flat normal, matte roughness, unoccluded. NoColorSpace is load-bearing:
      // tagging this sRGB would gamma-decode the roughness channel.
      surface: buildArray(
        CITY_SURFACE_PX,
        [128, 128, 217, 255],
        THREE.NoColorSpace,
        1,
      ),
    };
  }
  return arrays;
}

function readContext(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  // OffscreenCanvas keeps a 25 MB scratch surface off the DOM, but Safari only
  // grew 2d support for it in 16.4, so fall back rather than lose textures.
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  return canvas.getContext('2d', {
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D | null;
}

async function loadSheet(url: string, texture: THREE.DataArrayTexture, size: number): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  // colorSpaceConversion 'none' matters for the surface sheet: its channels are
  // normals and roughness, and a browser deciding to colour-manage them would
  // silently bend the shading.
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
  });
  try {
    const context = readContext(bitmap.width, bitmap.height);
    if (!context) throw new Error('no 2d context for city texture decode');
    context.drawImage(bitmap, 0, 0);
    const data = texture.image.data as Uint8Array;
    const stride = size * size * 4;
    for (let layer = 0; layer < CITY_TEX_LAYERS; layer += 1) {
      const pixels = context.getImageData(0, layer * size, size, size).data;
      data.set(pixels, layer * stride);
    }
  } finally {
    bitmap.close();
  }
  texture.needsUpdate = true;
}

/**
 * Start fetching the sheets. Idempotent; failures leave the neutral fill.
 *
 * Deliberately not awaited by any caller -- the city is drawable the moment the
 * manifest lands, and blocking that on 5 MB of concrete would trade a visible
 * delay for a cosmetic one.
 */
export function loadCityTextures(): void {
  if (loadStarted) return;
  loadStarted = true;
  const textures = cityTextures();
  void Promise.all([
    loadSheet('/textures/city/city-albedo.webp', textures.albedo, CITY_ALBEDO_PX),
    loadSheet('/textures/city/city-surface.webp', textures.surface, CITY_SURFACE_PX),
  ])
    .then(() => {
      // A silently untextured city renders fine in the fallback grey, so the
      // e2e capture waits on this rather than on a timeout.
      (window as unknown as Record<string, unknown>).__VIBE_CITY_TEX_READY__ = true;
      console.info('[city] concrete textures ready', {
        layers: CITY_TEX_LAYERS,
        wall: WALL_LAYER_COUNT,
        floor: FLOOR_LAYER_COUNT,
      });
    })
    .catch((error) => {
      // Not fatal: the neutral fill is a plausible concrete grey, so the city
      // stays playable and only loses its surface detail.
      console.warn('[city] concrete textures failed to load', error);
    });
}
