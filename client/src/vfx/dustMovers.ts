// Things moving through the dust push it: falling slabs, tumbling rubble,
// the cannonball. Ember's vehicle demo did this with moving sources that
// inject their velocity into the fluid and birth the far layer's parcels
// with their residual speed; this is the same idea against the city's
// awake bodies.
//
// Each frame the fastest bodies near the camera become movers: a position,
// a velocity, a radius. The fluid bricks take them as velocity sources; the
// parcel store gets a push per parcel within reach (spatially hashed, so a
// thousand parcels and fifty movers are a few thousand distance tests);
// and a big body moving fast sheds a faint wake parcel now and then, born
// with its velocity.

import type { CityClient } from '../city/cityClient';
import type { DustPolicy } from '../city/dustPolicy';
import { DustPalette, DustShape, type DustParcelStore } from './dustParcelStore';

export interface DustMover {
  key: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  radius: number;
  mass: number;
}

export interface DustMoverOptions {
  /** A body slower than this pushes nothing. */
  minSpeedMps: number;
  /** Bodies beyond this from the camera are ignored. */
  rangeM: number;
  /** Most movers kept per frame, nearest first. */
  maxMovers: number;
  /** A body this fast and this heavy sheds wake parcels. */
  wakeSpeedMps: number;
  wakeMassKg: number;
  wakeIntervalMs: number;
  maxWakePerFrame: number;
}

export const DEFAULT_DUST_MOVER_OPTIONS: DustMoverOptions = {
  minSpeedMps: 2,
  rangeM: 80,
  maxMovers: 48,
  wakeSpeedMps: 9,
  wakeMassKg: 1500,
  wakeIntervalMs: 250,
  maxWakePerFrame: 3,
};

/** The most a body can move dust in one second, m/s: parting it, not erasing it. */
const MAX_PUSH_MPS = 4;

const HASH_CELL_M = 8;

function fold(v: number): number {
  return v >= 0 ? v * 2 : -v * 2 - 1;
}

function hashKey(x: number, y: number, z: number): number {
  return (fold(Math.floor(x / HASH_CELL_M)) * 4096 + fold(Math.floor(y / HASH_CELL_M))) * 4096 + fold(Math.floor(z / HASH_CELL_M));
}

export class DustMovers {
  readonly options: DustMoverOptions;
  readonly movers: DustMover[] = [];
  private readonly pool: DustMover[] = [];
  private readonly previous = new Map<number, [number, number, number, number]>();
  private readonly nextWakeMs = new Map<number, number>();
  private readonly buckets = new Map<number, number[]>();
  private readonly bucketPool: number[][] = [];
  private nextSeed = 1;
  /** Telemetry. */
  pushed = 0;
  wakes = 0;

  constructor(options: Partial<DustMoverOptions> = {}) {
    this.options = { ...DEFAULT_DUST_MOVER_OPTIONS, ...options };
  }

  clear(): void {
    this.movers.length = 0;
    this.previous.clear();
    this.nextWakeMs.clear();
  }

  /**
   * Rebuild the mover list from the bodies the client presented this frame,
   * plus any extra bodies the caller knows about (the cannonball is a game
   * body, not a city island, and is the most obvious thing pushing dust).
   */
  update(
    client: CityClient, camX: number, camY: number, camZ: number, nowMs: number,
    extra?: Iterable<{ id: number; position: ArrayLike<number>; velocity: ArrayLike<number>; halfExtents: ArrayLike<number> }>,
  ): void {
    const o = this.options;
    const topology = client.topology;
    const movers = this.movers;
    movers.length = 0;
    let n = 0;
    if (extra) {
      for (const body of extra) {
        const speed = Math.hypot(body.velocity[0], body.velocity[1], body.velocity[2]);
        if (speed < o.minSpeedMps) continue;
        const dx = body.position[0] - camX;
        const dy = body.position[1] - camY;
        const dz = body.position[2] - camZ;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > o.rangeM) continue;
        const radius = Math.max(body.halfExtents[0], body.halfExtents[1], body.halfExtents[2]);
        let m = this.pool[n];
        if (!m) {
          m = { key: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, radius: 0, mass: 0 };
          this.pool[n] = m;
        }
        // Game bodies are keyed apart from the city's 0x8000_0000+ keys.
        m.key = 0x4000_0000 + body.id;
        m.x = body.position[0];
        m.y = body.position[1];
        m.z = body.position[2];
        m.vx = body.velocity[0];
        m.vy = body.velocity[1];
        m.vz = body.velocity[2];
        m.speed = speed;
        // A ball reaches a little past its surface.
        m.radius = radius * 2 + 0.5;
        // Density of the cannonball, roughly: a heavy, small thing.
        m.mass = 10_000;
        movers.push(m);
        n += 1;
      }
    }
    for (const key of client.liveBodyKeys()) {
      const body = topology.body(key);
      if (!body || body.settled) continue;
      const [x, y, z] = body.position;
      const dx = x - camX;
      const dy = y - camY;
      const dz = z - camZ;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > o.rangeM) continue;
      let vx: number;
      let vy: number;
      let vz: number;
      const v = client.bodyPresentedVelocity(key);
      const prev = this.previous.get(key);
      if (v) {
        vx = v[0];
        vy = v[1];
        vz = v[2];
      } else if (prev && nowMs > prev[3]) {
        const dt = (nowMs - prev[3]) / 1000;
        vx = (x - prev[0]) / dt;
        vy = (y - prev[1]) / dt;
        vz = (z - prev[2]) / dt;
      } else {
        vx = 0;
        vy = 0;
        vz = 0;
      }
      if (prev) {
        prev[0] = x;
        prev[1] = y;
        prev[2] = z;
        prev[3] = nowMs;
      } else {
        this.previous.set(key, [x, y, z, nowMs]);
      }
      const speed = Math.hypot(vx, vy, vz);
      if (speed < o.minSpeedMps) continue;
      const slots = body.chunkSlots;
      let mass = 0;
      let radius = 0;
      const scanned = Math.min(slots.length, 32);
      for (let i = 0; i < scanned; i += 1) {
        mass += topology.restMassOf(slots[i]);
        const r = topology.chunkRadiusOf(slots[i]);
        if (r > radius) radius = r;
      }
      if (scanned < slots.length) mass *= slots.length / scanned;
      radius = Math.min(8, radius * (1 + Math.cbrt(slots.length) * 0.5));
      let m = this.pool[n];
      if (!m) {
        m = { key: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, radius: 0, mass: 0 };
        this.pool[n] = m;
      }
      m.key = key;
      m.x = x;
      m.y = y;
      m.z = z;
      m.vx = vx;
      m.vy = vy;
      m.vz = vz;
      m.speed = speed;
      m.radius = radius;
      m.mass = mass;
      movers.push(m);
      n += 1;
    }
    if (movers.length > o.maxMovers) {
      // Nearest first.
      movers.sort((a, b) =>
        (a.x - camX) ** 2 + (a.y - camY) ** 2 + (a.z - camZ) ** 2
        - ((b.x - camX) ** 2 + (b.y - camY) ** 2 + (b.z - camZ) ** 2));
      movers.length = o.maxMovers;
    }
    // Forget bodies not seen for a while.
    if (this.previous.size > 4096) {
      for (const [key, p] of this.previous) if (nowMs - p[3] > 5000) this.previous.delete(key);
    }
  }

  /**
   * Push every live parcel within reach of a mover along the mover's
   * velocity and away from it, into the store's per-parcel offsets.
   */
  pushParcels(store: DustParcelStore, dtSeconds: number): void {
    const movers = this.movers;
    if (movers.length === 0 || store.liveCount === 0) return;
    // Hash live parcels by their birth cell; a parcel never drifts more than
    // its own radius from that, which the query radius covers.
    for (const list of this.buckets.values()) {
      list.length = 0;
      this.bucketPool.push(list);
    }
    this.buckets.clear();
    for (let slot = 0; slot < store.capacity; slot += 1) {
      if (!store.alive[slot]) continue;
      const key = hashKey(store.px[slot] + store.ox[slot], store.py[slot] + store.oy[slot], store.pz[slot] + store.oz[slot]);
      let list = this.buckets.get(key);
      if (!list) {
        list = this.bucketPool.pop() ?? [];
        this.buckets.set(key, list);
      }
      list.push(slot);
    }
    let pushed = 0;
    for (const m of movers) {
      const reach = m.radius + 6;
      const cx0 = Math.floor((m.x - reach) / HASH_CELL_M);
      const cx1 = Math.floor((m.x + reach) / HASH_CELL_M);
      const cy0 = Math.floor((m.y - reach) / HASH_CELL_M);
      const cy1 = Math.floor((m.y + reach) / HASH_CELL_M);
      const cz0 = Math.floor((m.z - reach) / HASH_CELL_M);
      const cz1 = Math.floor((m.z + reach) / HASH_CELL_M);
      for (let cz = cz0; cz <= cz1; cz += 1) {
        for (let cy = cy0; cy <= cy1; cy += 1) {
          for (let cx = cx0; cx <= cx1; cx += 1) {
            const list = this.buckets.get((fold(cx) * 4096 + fold(cy)) * 4096 + fold(cz));
            if (!list) continue;
            for (const slot of list) {
              const px = store.px[slot] + store.ox[slot];
              const py = store.py[slot] + store.oy[slot];
              const pz = store.pz[slot] + store.oz[slot];
              const dx = px - m.x;
              const dy = py - m.y;
              const dz = pz - m.z;
              const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
              // The parcel's own size, roughly: radius0 × the curve's early growth.
              const r = m.radius + store.radius0[slot] * 1.5;
              if (d >= r) continue;
              const w = 1 - d / r;
              // Carried with the body, and shoved out of its way -- but a
              // cloud is not knocked out of the air: the total is bounded.
              const along = Math.min(1, MAX_PUSH_MPS / m.speed);
              const carry = w * w * dtSeconds * 0.6 * along;
              const shove = w * dtSeconds * Math.min(m.speed, MAX_PUSH_MPS) * 0.6;
              const inv = d > 1e-3 ? 1 / d : 0;
              store.ox[slot] += m.vx * carry + dx * inv * shove;
              store.oy[slot] += m.vy * carry + dy * inv * shove;
              store.oz[slot] += m.vz * carry + dz * inv * shove;
              pushed += 1;
            }
          }
        }
      }
    }
    this.pushed = pushed;
  }

  /** Faint trails behind big fast bodies, born with their velocity. */
  emitWakes(policy: DustPolicy, nowMs: number): number {
    const o = this.options;
    let emitted = 0;
    for (const m of this.movers) {
      if (emitted >= o.maxWakePerFrame) break;
      if (m.speed < o.wakeSpeedMps || m.mass < o.wakeMassKg) continue;
      const next = this.nextWakeMs.get(m.key) ?? 0;
      if (nowMs < next) continue;
      this.nextWakeMs.set(m.key, nowMs + o.wakeIntervalMs);
      const seed = (this.nextSeed = (Math.imul(this.nextSeed, 1664525) + 1013904223) >>> 0);
      policy.spawnWake({
        bornMs: nowMs,
        x: m.x - (m.vx / m.speed) * m.radius * 0.5,
        y: m.y - (m.vy / m.speed) * m.radius * 0.5,
        z: m.z - (m.vz / m.speed) * m.radius * 0.5,
        vx: m.vx * 0.35,
        vy: m.vy * 0.35 + 0.5,
        vz: m.vz * 0.35,
        radius0: Math.min(2, Math.max(0.4, m.radius * 0.35)),
        intensity: Math.min(0.5, 0.15 + m.mass / 40000),
        seed,
        shape: DustShape.Smoulder,
        palette: DustPalette.Concrete,
      });
      emitted += 1;
    }
    this.wakes += emitted;
    return emitted;
  }
}
