// The destruction dust's only mutable state: a ring of immutable birth records.
//
// A parcel is one cloud of dust. It is born once, with a position, a push, a
// size and a thickness, and from then on everything about it -- where it has
// drifted, how big it has grown, how faint it has become -- is a pure function
// of its age. Nothing integrates, nothing is simulated per frame, and a frame
// that took 200 ms shows the same cloud a frame that took 8 ms would. This is
// the model the Ember lab used for its map-scale dust
// (lib/world/emission.mjs), and it is what lets thousands of parcels cost a few
// microseconds of CPU: the renderer evaluates the curve, uploads, and draws.
//
// The store is a fixed-capacity SoA ring. When it is full the oldest parcel is
// overwritten -- under a monotone fade the oldest is also the faintest, so
// that is the one nobody misses. Two halves write and read it: the emission
// policy (client/src/city/dustPolicy.ts) spawns, the renderers
// (DustVolumeRenderer, DustSprites) evaluate.

export const DUST_CAPACITY = 4096;

/** What kind of cloud: picks the growth curve, not the colour. */
export const enum DustShape {
  /** A fracture: a rounded burst that rises and spreads. */
  Fracture = 0,
  /** Rubble hitting the ground: flat and wide, barely rises. */
  Impact = 1,
  /** A collapse still going: small, slow, keeps coming. */
  Smoulder = 2,
  /** A shot landing: a fast spall jet, small and short-lived. */
  Entry = 3,
  /** A collapse front: wide, low, fast, and lingering. */
  Wave = 4,
}

/** What the dust is made of: picks the colour and how much of it there is. */
export const enum DustPalette {
  Concrete = 0,
  Wood = 1,
  Metal = 2,
  /** Glass makes no dust. */
  None = 3,
}

export interface DustShapeCurve {
  /** Radius at birth, m, before the per-parcel scale. */
  r0: number;
  /** Radius grows as sqrt(age) * growth. */
  growth: number;
  /** Total rise, m, approached as 1 - e^(-0.35 age). */
  rise: number;
  /** Seconds until the parcel is gone. */
  life: number;
  /** Height / width. */
  aspectY: number;
  /** Initial-velocity drag rate, 1/s: the push is spent as (1 - e^(-drag t)) / drag. */
  drag: number;
  /** Optical density multiplier. */
  density: number;
  /** How much of the parcel the erosion noise eats away by end of life. */
  erosion: number;
}

/** Indexed by DustShape. The renderer reads a curve; it never branches on the shape. */
export const DUST_SHAPES: readonly DustShapeCurve[] = [
  // r0 and growth multiply the parcel's radius0, so a cloud born at radius0
  // has grown ~1.9x by 1 s and ~3.8x at the end of its life.
  { r0: 1.0, growth: 0.9, rise: 2.0, life: 10, aspectY: 0.75, drag: 1.4, density: 1.6, erosion: 0.55 },
  { r0: 1.2, growth: 1.3, rise: 1.2, life: 14, aspectY: 0.40, drag: 1.4, density: 1.2, erosion: 0.50 },
  { r0: 0.8, growth: 0.9, rise: 2.0, life: 12, aspectY: 0.90, drag: 0.9, density: 0.7, erosion: 0.60 },
  { r0: 0.6, growth: 1.1, rise: 0.4, life: 5, aspectY: 0.80, drag: 2.2, density: 1.8, erosion: 0.70 },
  { r0: 1.5, growth: 1.6, rise: 0.8, life: 24, aspectY: 0.30, drag: 0.8, density: 1.0, erosion: 0.45 },
];

/** The longest any parcel lives, for anyone that needs a bound. */
export const DUST_MAX_LIFE_S = Math.max(...DUST_SHAPES.map((s) => s.life));

/** A birth record. Everything the renderer will ever know about the parcel. */
export interface DustParcel {
  /** performance.now() clock, ms. May be in the future: see CityClient.extractDust. */
  bornMs: number;
  x: number;
  y: number;
  z: number;
  /** Initial push, m/s, spent against the curve's drag. */
  vx: number;
  vy: number;
  vz: number;
  /** Multiplies the curve's radius. */
  radius0: number;
  /** 0..1, multiplies the curve's density. */
  intensity: number;
  /** Deterministic; the renderer derives rotation, mirror and noise offsets from it. */
  seed: number;
  shape: DustShape;
  palette: DustPalette;
  /**
   * Room around the birth point, m, along −x +x −y +y −z +z: how far the
   * cloud may extend before it would be inside a wall or floor. Infinity
   * (or omitted) means open air. The box and the drift are clamped to it.
   */
  clearance?: ArrayLike<number>;
}

/** What `evalParcel` fills: the parcel as it is right now. */
export interface DustEval {
  cx: number;
  cy: number;
  cz: number;
  /** Full box extents. */
  sx: number;
  sy: number;
  sz: number;
  /** Horizontal radius, m. */
  radius: number;
  age: number;
  fade: number;
  erosion: number;
  density: number;
  seed: number;
  serial: number;
  shape: DustShape;
  palette: DustPalette;
}

export interface DustEvalTuning {
  /** Multiplies every radius. */
  size: number;
  /** Multiplies every density. */
  density: number;
  /** Multiplies every lifetime. */
  lifetime: number;
}

export const DEFAULT_DUST_EVAL_TUNING: DustEvalTuning = { size: 1, density: 1, lifetime: 1 };

export function newDustEval(): DustEval {
  return {
    cx: 0, cy: 0, cz: 0, sx: 0, sy: 0, sz: 0, radius: 0, age: 0, fade: 0, erosion: 0,
    density: 0, seed: 0, serial: 0, shape: DustShape.Fracture, palette: DustPalette.Concrete,
  };
}

export class DustParcelStore {
  readonly capacity: number;
  readonly bornMs: Float64Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly radius0: Float32Array;
  readonly intensity: Float32Array;
  readonly seed: Uint32Array;
  readonly shape: Uint8Array;
  readonly palette: Uint8Array;
  /**
   * Monotonic id, unique for the parcel's life. LOD thinning keys on it
   * (serial % stride) so a parcel that is drawn stays drawn as the camera
   * moves, instead of flickering with the ring position.
   */
  readonly serial: Uint32Array;
  readonly alive: Uint8Array;
  /** Six per slot: −x +x −y +y −z +z, m. */
  readonly clearance: Float32Array;
  /**
   * Displacement pushed onto the parcel by moving bodies, m. The one thing
   * about a parcel that is not a function of its age; still clamped to its
   * room, and the only writer is dustMovers.pushParcels.
   */
  readonly ox: Float32Array;
  readonly oy: Float32Array;
  readonly oz: Float32Array;

  /** Next slot to write. Once wrapped, also the oldest parcel. */
  head = 0;
  /** Parcels alive at the last sweep. */
  liveCount = 0;
  /** Bumped by clear(); a renderer holding per-slot state resets when it changes. */
  generation = 0;
  /** Live parcels overwritten because the ring was full. Telemetry. */
  overwrittenLive = 0;
  /** Parcels ever spawned. Telemetry. */
  spawned = 0;

  private nextSerial = 1;

  constructor(capacity = DUST_CAPACITY) {
    this.capacity = capacity;
    this.bornMs = new Float64Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.pz = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.radius0 = new Float32Array(capacity);
    this.intensity = new Float32Array(capacity);
    this.seed = new Uint32Array(capacity);
    this.shape = new Uint8Array(capacity);
    this.palette = new Uint8Array(capacity);
    this.serial = new Uint32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.clearance = new Float32Array(capacity * 6).fill(Infinity);
    this.ox = new Float32Array(capacity);
    this.oy = new Float32Array(capacity);
    this.oz = new Float32Array(capacity);
  }

  /** Writes the record at the head and returns its slot. */
  spawn(p: DustParcel): number {
    const slot = this.head;
    if (this.alive[slot]) {
      this.overwrittenLive += 1;
    } else {
      this.liveCount += 1;
    }
    this.bornMs[slot] = p.bornMs;
    this.px[slot] = p.x;
    this.py[slot] = p.y;
    this.pz[slot] = p.z;
    this.vx[slot] = p.vx;
    this.vy[slot] = p.vy;
    this.vz[slot] = p.vz;
    this.radius0[slot] = p.radius0;
    this.intensity[slot] = p.intensity;
    this.seed[slot] = p.seed >>> 0;
    this.shape[slot] = p.shape;
    this.palette[slot] = p.palette;
    this.serial[slot] = this.nextSerial;
    const c6 = slot * 6;
    for (let i = 0; i < 6; i += 1) this.clearance[c6 + i] = p.clearance?.[i] ?? Infinity;
    this.ox[slot] = 0;
    this.oy[slot] = 0;
    this.oz[slot] = 0;
    this.alive[slot] = 1;
    this.nextSerial = (this.nextSerial + 1) >>> 0 || 1;
    this.head = (slot + 1) % this.capacity;
    this.spawned += 1;
    return slot;
  }

  /** Marks parcels past their lifetime dead. O(capacity); once per frame. */
  sweep(nowMs: number, lifetimeScale = 1): void {
    let live = 0;
    const { alive, bornMs, shape } = this;
    for (let slot = 0; slot < this.capacity; slot += 1) {
      if (!alive[slot]) continue;
      const life = DUST_SHAPES[shape[slot]].life * lifetimeScale * 1000;
      if (nowMs - bornMs[slot] >= life) {
        alive[slot] = 0;
      } else {
        live += 1;
      }
    }
    this.liveCount = live;
  }

  clear(): void {
    this.alive.fill(0);
    this.head = 0;
    this.liveCount = 0;
    this.generation += 1;
  }
}

/**
 * The parcel as it is at `nowMs`. Pure; ~40 flops; no allocation.
 *
 * Returns false for a parcel that is dead, or not yet born -- a birth stamped
 * in the future is how the emission keeps a puff from preceding the crack it
 * belongs to on a wire that applies fractures ahead of what is drawn.
 */
export function evalParcel(
  store: DustParcelStore,
  slot: number,
  nowMs: number,
  windX: number,
  windZ: number,
  tuning: DustEvalTuning,
  out: DustEval,
): boolean {
  if (!store.alive[slot]) return false;
  const shape = store.shape[slot] as DustShape;
  const curve = DUST_SHAPES[shape];
  const life = curve.life * tuning.lifetime;
  const t = (nowMs - store.bornMs[slot]) / 1000;
  if (t < 0 || t >= life) return false;

  const r = (curve.r0 + Math.sqrt(t) * curve.growth) * store.radius0[slot] * tuning.size;
  const spent = (1 - Math.exp(-curve.drag * t)) / curve.drag;
  const rise = curve.rise * (1 - Math.exp(-0.35 * t));
  // Wind takes hold as the push is spent, so a fresh burst goes where it was
  // thrown and an old cloud goes where the weather says.
  const carried = t - spent;
  let cx = store.px[slot] + store.vx[slot] * spent + windX * carried * 0.35 + store.ox[slot];
  let cy = store.py[slot] + store.vy[slot] * spent + rise + store.oy[slot];
  let cz = store.pz[slot] + store.vz[slot] * spent + windZ * carried * 0.35 + store.oz[slot];
  let hx = r;
  let hy = r * curve.aspectY;
  let hz = r;
  // Stay in the room: the box shrinks to fit between the walls it was born
  // among, and the centre cannot drift through them.
  const c6 = slot * 6;
  const cl = store.clearance;
  if (cl[c6] !== Infinity || cl[c6 + 1] !== Infinity) {
    const lo = store.px[slot] - cl[c6];
    const hi = store.px[slot] + cl[c6 + 1];
    hx = Math.min(hx, Math.max(0.2, (hi - lo) / 2));
    cx = Math.min(hi - hx, Math.max(lo + hx, cx));
  }
  if (cl[c6 + 2] !== Infinity || cl[c6 + 3] !== Infinity) {
    const lo = store.py[slot] - cl[c6 + 2];
    const hi = store.py[slot] + cl[c6 + 3];
    hy = Math.min(hy, Math.max(0.2, (hi - lo) / 2));
    cy = Math.min(hi - hy, Math.max(lo + hy, cy));
  }
  if (cl[c6 + 4] !== Infinity || cl[c6 + 5] !== Infinity) {
    const lo = store.pz[slot] - cl[c6 + 4];
    const hi = store.pz[slot] + cl[c6 + 5];
    hz = Math.min(hz, Math.max(0.2, (hi - lo) / 2));
    cz = Math.min(hi - hz, Math.max(lo + hz, cz));
  }
  out.cx = cx;
  out.cy = cy;
  out.cz = cz;
  out.sx = hx * 2;
  out.sy = hy * 2;
  out.sz = hz * 2;
  out.radius = Math.max(hx, hz);
  out.age = t;
  const remaining = 1 - t / life;
  out.fade = Math.min(1, 6 * t) * Math.pow(remaining, 1.8);
  out.erosion = Math.min(1, t / life) * curve.erosion;
  out.density = store.intensity[slot] * curve.density * tuning.density;
  out.seed = store.seed[slot];
  out.serial = store.serial[slot];
  out.shape = shape;
  out.palette = store.palette[slot] as DustPalette;
  return true;
}

/** The one store the city writes and the renderers read. */
export const dustParcels = new DustParcelStore();
