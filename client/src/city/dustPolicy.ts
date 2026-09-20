// How much dust a break makes.
//
// A source says "this much material let go, here, moving this way". The policy
// turns that into parcels: how many, how big, how thick, thrown where. The
// curves are sub-linear on purpose -- ten times the bonds is not ten times the
// clouds, it is a few more and much bigger ones, because the cost of a cloud
// is its screen area and overlapping clouds are the expensive kind. A hard
// per-tick cap holds the worst case, and sources arrive largest-first so the
// cap keeps the puffs that matter.
//
// Every random-looking number comes from a hash of (structure, tick, ordinal,
// index). The same fracture replayed makes the same dust, which is what lets
// a screenshot test mean anything.

import {
  DustPalette,
  DustShape,
  type DustParcelStore,
} from '../vfx/dustParcelStore';
import type { DustSource } from './destructionEvents';
import type { MaterialAppearance } from './manifest';

export interface DustPolicyConfig {
  /** Parcels one tick may spawn, across all its sources. */
  parcelsPerTickCap: number;
  parcelsPerSourceMax: number;
  /** n = round(parcelsScale · magnitude^0.6). */
  parcelsScale: number;
  /** radius0 = radiusScale · magnitude^(1/3), clamped to [radiusMin, radiusMax]. */
  radiusScale: number;
  radiusMin: number;
  radiusMax: number;
  /** A cell keeps smouldering this long after its last event. */
  smoulderHoldMs: number;
  smoulderIntervalMs: number;
  smoulderMaxCells: number;
  /** Cell size the smoulder keys on. */
  smoulderCellM: number;
  /** Fracture parcels start this far along the face normal, so the cloud is outside the wall. */
  normalOffsetM: number;
}

export const DEFAULT_DUST_POLICY: DustPolicyConfig = {
  parcelsPerTickCap: 48,
  parcelsPerSourceMax: 12,
  parcelsScale: 0.8,
  radiusScale: 0.6,
  radiusMin: 0.5,
  radiusMax: 4,
  smoulderHoldMs: 1500,
  smoulderIntervalMs: 350,
  smoulderMaxCells: 16,
  smoulderCellM: 4,
  normalOffsetM: 0.4,
};

export interface DustPolicyStats {
  emitted: number;
  droppedByTickCap: number;
  droppedByPalette: number;
  smoulderCells: number;
}

/** How thick each material's dust is; None makes no dust at all. */
const PALETTE_FACTOR: Record<DustPalette, number> = {
  [DustPalette.Concrete]: 1,
  [DustPalette.Wood]: 0.7,
  [DustPalette.Metal]: 0.3,
  [DustPalette.None]: 0,
};

/** What a material index looks like as dust, by its appearance name. */
export function paletteFromAppearance(
  appearance: readonly MaterialAppearance[] | undefined,
  material: number,
): DustPalette {
  const entry = appearance?.[material];
  if (!entry) return DustPalette.Concrete;
  const name = `${entry.name ?? ''} ${entry.textureKey ?? ''}`.toLowerCase();
  if (/glass|glazing|window/.test(name)) return DustPalette.None;
  if (/wood|timber|plank/.test(name)) return DustPalette.Wood;
  if (/steel|metal|iron|girder/.test(name)) return DustPalette.Metal;
  return DustPalette.Concrete;
}

/** 32-bit mix of four ints. Good enough to seed a parcel; not a cryptographic anything. */
export function hash32(a: number, b: number, c: number, d: number): number {
  let h = (a * 0x9e3779b1) >>> 0;
  h = (Math.imul(h ^ (b + 0x85ebca77), 0xc2b2ae3d) ^ (h >>> 15)) >>> 0;
  h = (Math.imul(h ^ (c + 0x27d4eb2f), 0x165667b1) ^ (h >>> 13)) >>> 0;
  h = (Math.imul(h ^ (d + 0x9e3779b1), 0x85ebca77) ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** A tiny LCG on a seed: unit floats, deterministic. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
}

interface SmoulderCell {
  x: number;
  y: number;
  z: number;
  structureId: number;
  ordinal: number;
  lastFedMs: number;
  nextMs: number;
  magnitude: number;
  palette: DustPalette;
  serial: number;
}

export class DustPolicy {
  readonly config: DustPolicyConfig;
  readonly stats: DustPolicyStats = { emitted: 0, droppedByTickCap: 0, droppedByPalette: 0, smoulderCells: 0 };
  private currentTick = -1;
  private tickBudget = 0;
  private readonly smoulder = new Map<number, SmoulderCell>();

  constructor(
    private readonly store: DustParcelStore,
    private readonly paletteOf: (material: number) => DustPalette,
    config: Partial<DustPolicyConfig> = {},
  ) {
    this.config = { ...DEFAULT_DUST_POLICY, ...config };
  }

  /** Burst emission for one source. Returns parcels spawned. */
  emit(source: DustSource): number {
    const cfg = this.config;
    if (source.simTick !== this.currentTick) {
      this.currentTick = source.simTick;
      this.tickBudget = cfg.parcelsPerTickCap;
    }
    const palette = this.paletteOf(source.material);
    const factor = PALETTE_FACTOR[palette];
    if (factor <= 0) {
      this.stats.droppedByPalette += 1;
      return 0;
    }
    const m = Math.max(0, source.magnitude);
    let n = Math.max(1, Math.min(cfg.parcelsPerSourceMax, Math.round(cfg.parcelsScale * Math.pow(m, 0.6))));
    if (n > this.tickBudget) {
      this.stats.droppedByTickCap += n - this.tickBudget;
      n = this.tickBudget;
    }
    if (n <= 0) return 0;
    this.tickBudget -= n;

    const impact = source.kind === 'impact';
    const radius0 = Math.min(cfg.radiusMax, Math.max(cfg.radiusMin, cfg.radiusScale * Math.cbrt(m))) * (impact ? 1.5 : 1);
    const intensity = Math.min(1, 0.35 + 0.15 * Math.log2(1 + m)) * factor;
    const shape = impact ? DustShape.Impact : DustShape.Fracture;
    const ox = source.x + source.nx * cfg.normalOffsetM;
    const oy = source.y + source.ny * cfg.normalOffsetM;
    const oz = source.z + source.nz * cfg.normalOffsetM;

    for (let i = 0; i < n; i += 1) {
      const seed = hash32(source.structureId, source.simTick, source.ordinal, i);
      const rng = new Rng(seed);
      const theta = rng.range(0, Math.PI * 2);
      let x: number;
      let y: number;
      let z: number;
      let vx: number;
      let vy: number;
      let vz: number;
      if (impact) {
        // A disc on the ground, thrown outward and flat.
        const r = radius0 * 1.2 * Math.sqrt(rng.next());
        x = ox + Math.cos(theta) * r;
        y = oy + 0.2;
        z = oz + Math.sin(theta) * r;
        const push = rng.range(1.5, 3);
        vx = Math.cos(theta) * push;
        vy = 0;
        vz = Math.sin(theta) * push;
      } else {
        // A ball around the break, thrown every way and a little up, plus
        // whatever the material was doing.
        const r = radius0 * 0.6 * Math.cbrt(rng.next());
        const phi = Math.acos(rng.range(-1, 1));
        x = ox + Math.sin(phi) * Math.cos(theta) * r;
        y = oy + Math.cos(phi) * r;
        z = oz + Math.sin(phi) * Math.sin(theta) * r;
        const push = rng.range(0.5, 1.5);
        const phi2 = Math.acos(rng.range(-1, 1));
        const theta2 = rng.range(0, Math.PI * 2);
        vx = source.vx + Math.sin(phi2) * Math.cos(theta2) * push + source.nx * push;
        vy = source.vy + Math.cos(phi2) * push + 0.8 + source.ny * push;
        vz = source.vz + Math.sin(phi2) * Math.sin(theta2) * push + source.nz * push;
      }
      this.store.spawn({
        bornMs: source.atMs,
        x, y, z, vx, vy, vz,
        radius0: radius0 * rng.range(0.8, 1.2),
        intensity: intensity * rng.range(0.8, 1),
        seed,
        shape,
        palette,
      });
    }
    this.stats.emitted += n;

    if (!impact) this.feedSmoulder(source, palette);
    return n;
  }

  /** Keeps a cell smouldering after a break; more breaks there keep it going. */
  private feedSmoulder(source: DustSource, palette: DustPalette): void {
    const cfg = this.config;
    const size = cfg.smoulderCellM;
    const hashed = hash32(
      source.structureId,
      Math.floor(source.x / size) + 100000,
      Math.floor(source.y / size) + 100000,
      Math.floor(source.z / size) + 100000,
    );
    const cell = this.smoulder.get(hashed);
    if (cell) {
      cell.lastFedMs = source.atMs;
      cell.magnitude = Math.max(cell.magnitude, source.magnitude);
      return;
    }
    if (this.smoulder.size >= cfg.smoulderMaxCells) {
      let stalest: number | undefined;
      let stalestMs = Infinity;
      for (const [k, c] of this.smoulder) {
        if (c.lastFedMs < stalestMs) {
          stalestMs = c.lastFedMs;
          stalest = k;
        }
      }
      if (stalest !== undefined) this.smoulder.delete(stalest);
    }
    this.smoulder.set(hashed, {
      x: source.x, y: source.y, z: source.z,
      structureId: source.structureId, ordinal: source.ordinal,
      lastFedMs: source.atMs, nextMs: source.atMs + cfg.smoulderIntervalMs,
      magnitude: source.magnitude, palette, serial: 0,
    });
  }

  /** Per frame: advances the smoulder emitters. */
  tick(nowMs: number): void {
    const cfg = this.config;
    for (const [key, cell] of this.smoulder) {
      if (nowMs - cell.lastFedMs > cfg.smoulderHoldMs) {
        this.smoulder.delete(key);
        continue;
      }
      // Bounded catch-up after a stall: never more than one interval behind.
      cell.nextMs = Math.max(cell.nextMs, nowMs - cfg.smoulderIntervalMs);
      while (cell.nextMs <= nowMs) {
        const seed = hash32(cell.structureId, 0xfff0, cell.ordinal, cell.serial);
        cell.serial += 1;
        const rng = new Rng(seed);
        const theta = rng.range(0, Math.PI * 2);
        const r = rng.range(0, 1.5);
        this.store.spawn({
          bornMs: cell.nextMs,
          x: cell.x + Math.cos(theta) * r,
          y: cell.y + rng.range(-0.5, 0.5),
          z: cell.z + Math.sin(theta) * r,
          vx: rng.range(-0.3, 0.3),
          vy: 0.6,
          vz: rng.range(-0.3, 0.3),
          radius0: 0.8,
          intensity: 0.25 * Math.min(1, cell.magnitude / 40) * PALETTE_FACTOR[cell.palette],
          seed,
          shape: DustShape.Smoulder,
          palette: cell.palette,
        });
        this.stats.emitted += 1;
        cell.nextMs += cfg.smoulderIntervalMs;
      }
    }
    this.stats.smoulderCells = this.smoulder.size;
  }

  clear(): void {
    this.smoulder.clear();
    this.currentTick = -1;
    this.tickBudget = 0;
    this.stats.smoulderCells = 0;
  }
}
