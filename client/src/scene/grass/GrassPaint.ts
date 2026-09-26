import { foliageSpeciesId, type FoliageSpecies } from './foliageProfiles';
import { Color, DataTexture, LinearFilter, RGBAFormat } from 'three';

export const GRASS_PAINT_TILE_METRES = 8;
export const GRASS_MAX_HEIGHT = 4;
const CELLS = 16, CELL = 0.5, CHANNELS = 12, HALF = 256;
export interface GrassBrush {
  density: number; height: number; color: string;
  mode?: 'all' | 'appearance';
  species?: FoliageSpecies; health?: number; dryness?: number; maturity?: number;
  rowSpacing?: number; rowAngle?: number; stiffness?: number;
}
export const GRASS_BRUSHES: Record<string, GrassBrush> = {
  meadow: { density: 1, height: 0.55, color: '#7e9c46' },
  lawn: { density: 0.95, height: 0.22, color: '#59813e' },
  tall: { density: 1, height: 1.25, color: '#8ba052' },
  person: { density: 1, height: 2.8, color: '#809347' },
  vehicle: { density: 1, height: 4, color: '#8d9c52' },
  dry: { density: 0.5, height: 0.6, color: '#b39a66', health: 0.3, dryness: 0.9 },
  lush: { density: 1, height: 0.45, color: '#43832d', health: 1, dryness: 0 },
  reeds: { density: 1, height: 2.8, color: '#6c8741', species: 'reed', stiffness: 0.75 },
  wheat: { density: 1, height: 1.3, color: '#bea65e', species: 'wheat', dryness: 0.55, rowSpacing: 0.4 },
  corn: { density: 1, height: 3, color: '#59923b', species: 'corn', rowSpacing: 0.85, stiffness: 0.85 },
  ferns: { density: 0.8, height: 0.85, color: '#427842', species: 'fern', stiffness: 0.35 },
  scorched: { density: 0.3, height: 0.3, color: '#493d25', health: 0, dryness: 1 },
  bare: { density: 0, height: 0.3, color: '#92774c' },
};
export interface GrassPaintDocument { version: 1 | 2 | 3; tiles: Array<{ x: number; z: number; data: number[] }> }
export interface GrassPaintBounds { minX: number; minZ: number; maxX: number; maxZ: number }
const color = new Color();
const green = new Color('#7e9c46'), straw = new Color('#b39a66');
const clamp = (x: number, min = 0, max = 1) => Math.max(min, Math.min(max, x));

/** Sparse 0.5 m authoring tiles. Only painted ground is stored. No blade edits. */
export class GrassPaint {
  private readonly heightSample: number[] = [];
  private readonly tiles = new Map<string, Uint8Array>();
  private readonly listeners = new Set<(bounds: GrassPaintBounds) => void>();
  revision = 0;
  private readonly coverData = new Uint8Array(256 * 256 * 4);
  readonly cover = new DataTexture(this.coverData, 256, 256, RGBAFormat);

  constructor() {
    this.cover.name = 'Grass density and canopy colour';
    this.cover.minFilter = this.cover.magFilter = LinearFilter;
    this.cover.generateMipmaps = false;
    this.updateCover({ minX: -HALF, minZ: -HALF, maxX: HALF, maxZ: HALF });
  }

  private defaults(x: number, z: number, out: number[] | Uint8Array, offset = 0): void {
    // Patches of dry/open growth, not a uniformly green carpet. Paint overrides these.
    const moisture = clamp(0.6 + 0.3 * Math.sin(x * 0.047 + Math.sin(z * 0.061))
      + 0.18 * Math.cos(z * 0.097 + x * 0.031));
    const dry = clamp((0.4 - moisture) * 2);
    out[offset] = Math.round((0.6 + moisture * 0.4) * 255);
    out[offset + 1] = Math.round((0.32 + moisture * 0.24) / GRASS_MAX_HEIGHT * 255);
    out[offset + 2] = Math.round((green.r + (straw.r-green.r)*dry) * 255);
    out[offset + 3] = Math.round((green.g + (straw.g-green.g)*dry) * 255);
    out[offset + 4] = Math.round((green.b + (straw.b-green.b)*dry) * 255);
    out[offset + 5] = 0; // Species (categorical, not interpolated).
    out[offset + 6] = 255; out[offset + 7] = 0; out[offset + 8] = 255;
    out[offset + 9] = 0; out[offset + 10] = 0; out[offset + 11] = 128;
  }

  private cell(ix: number, iz: number, out: number[], offset = 0): void {
    const tx = Math.floor(ix / CELLS), tz = Math.floor(iz / CELLS);
    const tile = this.tiles.get(`${tx},${tz}`);
    if (!tile) { this.defaults((ix + 0.5) * CELL, (iz + 0.5) * CELL, out, offset); return; }
    const at = ((iz - tz * CELLS) * CELLS + ix - tx * CELLS) * CHANNELS;
    for (let c = 0; c < CHANNELS; c++) out[offset + c] = tile[at + c];
  }

  /** Cheap world-space height lookup for broad vehicle canopy contacts. */
  heightAt(x: number, z: number): number {
    const gx = x / CELL - 0.5, gz = z / CELL - 0.5;
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx-ix, fz = gz-iz;
    let height = 0;
    for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      this.cell(ix+dx, iz+dz, this.heightSample);
      height += this.heightSample[1] * (dx ? fx : 1-fx) * (dz ? fz : 1-fz);
    }
    return height / 255 * GRASS_MAX_HEIGHT;
  }

  /** Bake a tiny padded grid once per generated patch; sampling blades is allocation-free. */
  sampler(px: number, pz: number): (x: number, z: number, out: number[]) => void {
    const stride = CELLS + 2, grid = new Array<number>(stride * stride * CHANNELS);
    for (let z = -1; z <= CELLS; z++) for (let x = -1; x <= CELLS; x++) {
      this.cell(px * CELLS + x, pz * CELLS + z, grid, ((z + 1) * stride + x + 1) * CHANNELS);
    }
    return (x, z, out) => {
      const gx = x / CELL + 0.5, gz = z / CELL + 0.5;
      const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
      const a = (iz * stride + ix) * CHANNELS, b = a + CHANNELS, c = a + stride * CHANNELS, d = c + CHANNELS;
      for (let k = 0; k < CHANNELS; k++) {
        if (k === 5 || k === 9 || k === 10) {
          out[k] = grid[(fz < 0.5 ? (fx < 0.5 ? a : b) : (fx < 0.5 ? c : d)) + k]/255;
          continue;
        }
        out[k] = ((grid[a + k] * (1-fx) + grid[b + k] * fx) * (1-fz)
          + (grid[c + k] * (1-fx) + grid[d + k] * fx) * fz) / 255;
      }
    };
  }

  paint(x: number, z: number, radius: number, brush: GrassBrush, strength = 1): void {
    if (![x, z, radius, brush.density, brush.height, strength, brush.health ?? 1, brush.dryness ?? 0, brush.maturity ?? 1, brush.rowSpacing ?? 0, brush.rowAngle ?? 0, brush.stiffness ?? 0.5].every(Number.isFinite)) return;
    radius = clamp(radius, 0.5, 24);
    const bounds = { minX: Math.max(-HALF, x-radius), minZ: Math.max(-HALF, z-radius), maxX: Math.min(HALF, x+radius), maxZ: Math.min(HALF, z+radius) };
    if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ || strength <= 0) return;
    color.set(brush.color);
    const target = [clamp(brush.density) * 255, clamp(brush.height, 0.05, GRASS_MAX_HEIGHT) / GRASS_MAX_HEIGHT * 255, color.r * 255, color.g * 255, color.b * 255,
      foliageSpeciesId(brush.species), clamp(brush.health ?? 1)*255, clamp(brush.dryness ?? 0)*255,
      clamp(brush.maturity ?? 1)*255, clamp(brush.rowSpacing ?? 0, 0, 4)/4*255,
      (((brush.rowAngle ?? 0)%360+360)%360)/360*255, clamp(brush.stiffness ?? 0.5)*255];
    for (let iz = Math.floor(bounds.minZ / CELL); iz < Math.ceil(bounds.maxZ / CELL); iz++) {
      for (let ix = Math.floor(bounds.minX / CELL); ix < Math.ceil(bounds.maxX / CELL); ix++) {
        const distance = Math.hypot((ix+0.5)*CELL-x, (iz+0.5)*CELL-z) / radius;
        if (distance >= 1) continue;
        const tx = Math.floor(ix / CELLS), tz = Math.floor(iz / CELLS), key = `${tx},${tz}`;
        let tile = this.tiles.get(key);
        if (!tile) {
          tile = new Uint8Array(CELLS * CELLS * CHANNELS);
          for (let dz = 0; dz < CELLS; dz++) for (let dx = 0; dx < CELLS; dx++) {
            this.defaults((tx*CELLS+dx+0.5)*CELL, (tz*CELLS+dz+0.5)*CELL, tile, (dz*CELLS+dx)*CHANNELS);
          }
          this.tiles.set(key, tile);
        }
        const edge = clamp((1-distance) / 0.35);
        const mix = edge * edge * (3-2*edge) * clamp(strength);
        const at = ((iz-tz*CELLS)*CELLS+ix-tx*CELLS)*CHANNELS;
        for (let k = 0; k < CHANNELS; k++) {
          if (brush.mode === 'appearance' && ![2,3,4,6,7].includes(k)) continue;
          if (k === 5 || k === 9 || k === 10) { if (mix >= 0.5) tile[at+k] = Math.round(target[k]); }
          else tile[at+k] = Math.round(tile[at+k] + (target[k]-tile[at+k])*mix);
        }
      }
    }
    this.changed(bounds);
  }

  private updateCover(bounds: GrassPaintBounds): void {
    const sample: number[] = [];
    for (let z = Math.max(0, Math.floor((bounds.minZ+HALF)/2)-1); z < Math.min(256, Math.ceil((bounds.maxZ+HALF)/2)+1); z++) {
      for (let x = Math.max(0, Math.floor((bounds.minX+HALF)/2)-1); x < Math.min(256, Math.ceil((bounds.maxX+HALF)/2)+1); x++) {
        this.cell(Math.floor((x*2-HALF+1)/CELL), Math.floor((z*2-HALF+1)/CELL), sample);
        const i = (z*256+x)*4;
        this.coverData.set([sample[2], sample[3], sample[4], sample[0]], i);
      }
    }
    this.cover.needsUpdate = true;
  }
  private changed(bounds: GrassPaintBounds): void {
    this.revision++;
    this.updateCover(bounds);
    for (const listener of this.listeners) listener(bounds);
  }
  subscribe(listener: (bounds: GrassPaintBounds) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  export(): GrassPaintDocument {
    return { version: 3, tiles: [...this.tiles].map(([key, data]) => {
      const [x,z] = key.split(',').map(Number); return { x, z, data: Array.from(data) };
    }) };
  }
  /** Only the 3×3 neighborhood needed for padded bilinear patch sampling. */
  patchDocument(px: number, pz: number): GrassPaintDocument {
    const tiles: GrassPaintDocument['tiles'] = [];
    for (let z = pz-1; z <= pz+1; z++) for (let x = px-1; x <= px+1; x++) {
      const data = this.tiles.get(`${x},${z}`);
      if (data) tiles.push({ x, z, data: Array.from(data) });
    }
    return { version: 3, tiles };
  }

  import(value: unknown): void {
    const doc = value as GrassPaintDocument;
    if (!doc || (doc.version !== 1 && doc.version !== 2 && doc.version !== 3) || !Array.isArray(doc.tiles) || doc.tiles.length > 4096) throw new Error('Invalid grass layout');
    const next = new Map<string, Uint8Array>();
    const channels = doc.version === 3 ? CHANNELS : 5;
    for (const tile of doc.tiles) {
      if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.z) || tile.x < -32 || tile.x >= 32 || tile.z < -32 || tile.z >= 32
        || !Array.isArray(tile.data) || tile.data.length !== CELLS*CELLS*channels
        || tile.data.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Invalid grass tile');
      if (next.has(`${tile.x},${tile.z}`)) throw new Error('Duplicate grass tile');
      const data = new Uint8Array(CELLS*CELLS*CHANNELS);
      for (let cell = 0; cell < CELLS*CELLS; cell++) {
        const at = cell*CHANNELS;
        data.set([0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 128], at);
        data.set(tile.data.slice(cell*channels, (cell+1)*channels), at);
        if (data[at+5] > 4) throw new Error('Invalid foliage species');
        if (doc.version === 1) data[at+1] = Math.round(data[at+1]*2/GRASS_MAX_HEIGHT);
      }
      next.set(`${tile.x},${tile.z}`, data);
    }
    const changed: GrassPaintBounds[] = [];
    for (const key of new Set([...this.tiles.keys(), ...next.keys()])) {
      const before = this.tiles.get(key), after = next.get(key);
      if (before && after && before.every((byte, i) => byte === after[i])) continue;
      const [x,z] = key.split(',').map(Number);
      changed.push({ minX: x*8, minZ: z*8, maxX: x*8+8, maxZ: z*8+8 });
    }
    this.tiles.clear(); for (const [key,tile] of next) this.tiles.set(key,tile);
    for (const bounds of changed) this.changed(bounds);
  }
  clear(): void { this.import({ version: 1, tiles: [] }); }
  dispose(): void { this.cover.dispose(); this.listeners.clear(); }
}

export const cityGrassPaint = new GrassPaint();
let sharedCityReaders = 0;
export function retainSharedCityGrass(): () => void {
  sharedCityReaders++;
  return () => { sharedCityReaders = Math.max(0, sharedCityReaders-1); };
}
const STORAGE_KEY = 'vibe.city.grassPaint.v1';
export function saveCityGrassPaint(): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cityGrassPaint.export())); return true; } catch { return false; }
}
if (typeof window !== 'undefined') {
  try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) cityGrassPaint.import(JSON.parse(saved)); } catch { /* Invalid stored layouts use defaults. */ }
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY || sharedCityReaders > 0) return;
    try { if (event.newValue) cityGrassPaint.import(JSON.parse(event.newValue)); else cityGrassPaint.clear(); } catch { /* Keep the last valid layout. */ }
  });
}
