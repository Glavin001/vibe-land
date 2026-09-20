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
  type DustParcel,
  type DustParcelStore,
} from '../vfx/dustParcelStore';
import type { DustSource } from './destructionEvents';
import type { MaterialAppearance } from './manifest';

export interface DustPolicyConfig {
  /** Parcels one tick may spawn, across all its sources. */
  parcelsPerTickCap: number;
  parcelsPerSourceMax: number;
  /** n = round(parcelsScale · magnitude^0.5). Few and big: overlapping volumes are the expensive kind. */
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
  parcelsPerTickCap: 32,
  parcelsPerSourceMax: 8,
  parcelsScale: 0.55,
  radiusScale: 0.45,
  radiusMin: 0.4,
  radiusMax: 3,
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

  /** Room measurement at a birth point, when the layer has a city to measure against. */
  clearanceOf: ((x: number, y: number, z: number, out: Float32Array) => void) | null = null;
  private readonly clearance = new Float32Array(6);

  constructor(
    private readonly store: DustParcelStore,
    private readonly paletteOf: (material: number) => DustPalette,
    config: Partial<DustPolicyConfig> = {},
  ) {
    this.config = { ...DEFAULT_DUST_POLICY, ...config };
  }

  /** The narrowest axis of a measured room, m. */
  private roomOf(c: Float32Array): number {
    return Math.min(c[0] + c[1], c[2] + c[3], c[4] + c[5]);
  }

  private spawnAt(p: Omit<DustParcel, 'clearance'>): void {
    if (this.clearanceOf) {
      this.clearanceOf(p.x, p.y, p.z, this.clearance);
      this.store.spawn({ ...p, clearance: this.clearance });
    } else {
      this.store.spawn(p);
    }
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
    let n = Math.max(1, Math.min(cfg.parcelsPerSourceMax, Math.round(cfg.parcelsScale * Math.sqrt(m))));
    if (source.kind === 'wave') n = Math.max(6, n);
    if (n > this.tickBudget) {
      this.stats.droppedByTickCap += n - this.tickBudget;
      n = this.tickBudget;
    }
    if (n <= 0) return 0;
    this.tickBudget -= n;

    const kind = source.kind;
    const impact = kind === 'impact' || kind === 'wave';
    const entry = kind === 'entry';
    const wave = kind === 'wave';
    const radius0 = Math.min(cfg.radiusMax, Math.max(cfg.radiusMin, cfg.radiusScale * Math.cbrt(m)))
      * (wave ? 2 : impact ? 1.5 : entry ? 0.6 : 1);
    const intensity = Math.min(1, 0.35 + 0.15 * Math.log2(1 + m)) * factor;
    const shape = wave ? DustShape.Wave : impact ? DustShape.Impact : entry ? DustShape.Entry : DustShape.Fracture;
    // A bond's normal has no side of its own: the face's outside is whichever
    // side has room. Born inside the standing chunk, a puff has none and
    // collapses to nothing; so measure both sides and take the open one.
    let nx = source.nx;
    let ny = source.ny;
    let nz = source.nz;
    let ox = source.x + nx * cfg.normalOffsetM;
    let oy = source.y + ny * cfg.normalOffsetM;
    let oz = source.z + nz * cfg.normalOffsetM;
    if (this.clearanceOf && !impact) {
      this.clearanceOf(ox, oy, oz, this.clearance);
      const room = this.roomOf(this.clearance);
      if (room < 1) {
        const bx = source.x - nx * cfg.normalOffsetM;
        const by = source.y - ny * cfg.normalOffsetM;
        const bz = source.z - nz * cfg.normalOffsetM;
        this.clearanceOf(bx, by, bz, this.clearance);
        if (this.roomOf(this.clearance) > room) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
          ox = bx;
          oy = by;
          oz = bz;
        }
      }
    }
    // A tangent basis around the normal, for the discs and the ring.
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    const hx = Math.abs(ny) < 0.9 ? 0 : 1;
    const hy = Math.abs(ny) < 0.9 ? 1 : 0;
    let tx = hy * nz - 0 * ny;
    let ty = 0 * nx - hx * nz;
    let tz = hx * ny - hy * nx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    for (let i = 0; i < n; i += 1) {
      const seed = hash32(source.structureId, source.simTick, source.ordinal, i);
      const rng = new Rng(seed);
      const theta = wave ? (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3) : rng.range(0, Math.PI * 2);
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      let x: number;
      let y: number;
      let z: number;
      let vx: number;
      let vy: number;
      let vz: number;
      if (wave) {
        // A ring around the front, every parcel pushed outward, hard.
        const r = radius0 * 0.8;
        x = ox + (tx * ct + bx * st) * r;
        y = oy + 0.3;
        z = oz + (tz * ct + bz * st) * r;
        const push = rng.range(5, 9);
        vx = (tx * ct + bx * st) * push;
        vy = 0.3;
        vz = (tz * ct + bz * st) * push;
      } else if (impact) {
        // A disc on the surface it hit, thrown outward along it.
        const r = radius0 * 1.2 * Math.sqrt(rng.next());
        x = ox + (tx * ct + bx * st) * r;
        y = oy + (ty * ct + by * st) * r + ny * 0.2;
        z = oz + (tz * ct + bz * st) * r;
        const push = rng.range(1.5, 3);
        vx = (tx * ct + bx * st) * push;
        vy = (ty * ct + by * st) * push;
        vz = (tz * ct + bz * st) * push;
      } else if (entry) {
        // Spall: a fast jet off the face, toward the shooter.
        const r = radius0 * 0.5 * Math.sqrt(rng.next());
        x = ox + (tx * ct + bx * st) * r;
        y = oy + (ty * ct + by * st) * r;
        z = oz + (tz * ct + bz * st) * r;
        const push = rng.range(4, 8);
        const spread = rng.range(0, 0.35);
        vx = source.vx + (nx + (tx * ct + bx * st) * spread) * push;
        vy = source.vy + (ny + (ty * ct + by * st) * spread) * push;
        vz = source.vz + (nz + (tz * ct + bz * st) * spread) * push;
      } else {
        // A ball around the break, thrown every way and a little up, plus
        // whatever the material was doing.
        const r = radius0 * 0.6 * Math.cbrt(rng.next());
        const phi = Math.acos(rng.range(-1, 1));
        x = ox + Math.sin(phi) * ct * r;
        y = oy + Math.cos(phi) * r;
        z = oz + Math.sin(phi) * st * r;
        const push = rng.range(0.5, 1.5);
        const phi2 = Math.acos(rng.range(-1, 1));
        const theta2 = rng.range(0, Math.PI * 2);
        vx = source.vx + Math.sin(phi2) * Math.cos(theta2) * push + source.nx * push;
        vy = source.vy + Math.cos(phi2) * push + 0.8 + source.ny * push;
        vz = source.vz + Math.sin(phi2) * Math.sin(theta2) * push + source.nz * push;
      }
      this.spawnAt({
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

    if (kind === 'fracture' || kind === 'entry') this.feedSmoulder(source, palette);
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
        this.spawnAt({
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
