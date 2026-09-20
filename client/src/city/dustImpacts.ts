// Impacts read off the velocity stream, and the collapse front they add up to.
//
// The server never says "this hit that". It does say, thirty times a second,
// how fast every moving body is going, and a body that was falling at eight
// metres a second and is now going two hit something hard enough to stop.
// That discontinuity is the impact: its size is the body's mass times the
// speed it lost, its place is the body's underside along the direction it
// was stopped, and whether it was the ground or another piece of rubble is
// the height and the direction of the change.
//
// Enough of those in one place at once is a collapse front -- floors
// pancaking push a wall of dust out sideways -- and that is reported as one
// wave source rather than a hundred puffs.

import { DustSourceQueue, type DustSource } from './destructionEvents';

export interface DustImpactOptions {
  /** A body slower than this before the change cannot have hit anything worth dust. */
  minSpeedMps: number;
  /** The speed it must lose in one sample. */
  minDeltaMps: number;
  /** The same body raises at most one impact per this long. */
  cooldownMs: number;
  /** kg·m/s per dust unit. */
  impulsePerUnit: number;
  /** Cell size the wave aggregates in. */
  waveCellM: number;
  /** Window the wave sums over. */
  waveWindowMs: number;
  /** Σ impulse in a cell within the window that makes a wave. */
  waveImpulse: number;
  /** A cell raises at most one wave per this long. */
  waveCooldownMs: number;
}

export const DEFAULT_DUST_IMPACT_OPTIONS: DustImpactOptions = {
  minSpeedMps: 3,
  minDeltaMps: 4,
  cooldownMs: 300,
  impulsePerUnit: 4000,
  waveCellM: 8,
  waveWindowMs: 500,
  waveImpulse: 100_000,
  waveCooldownMs: 2000,
};

interface BodyMotion {
  tick: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  lastImpactMs: number;
}

interface WaveCell {
  impulse: number;
  since: number;
  lowestY: number;
  x: number;
  z: number;
  count: number;
  lastWaveMs: number;
  structureId: number;
}

const scratch: DustSource = {
  kind: 'impact', structureId: 0, simTick: 0, ordinal: 0, x: 0, y: 0, z: 0,
  nx: 0, ny: 1, nz: 0, vx: 0, vy: 0, vz: 0, magnitude: 0, count: 1, material: 0, atMs: 0,
};

export class DustImpactDetector {
  readonly options: DustImpactOptions;
  private readonly bodies = new Map<number, BodyMotion>();
  private readonly waves = new Map<number, WaveCell>();
  private ordinal = 0;
  /** Telemetry. */
  impacts = 0;
  wavesRaised = 0;

  constructor(options: Partial<DustImpactOptions> = {}) {
    this.options = { ...DEFAULT_DUST_IMPACT_OPTIONS, ...options };
  }

  forget(key: number): void {
    this.bodies.delete(key);
  }

  clear(): void {
    this.bodies.clear();
    this.waves.clear();
  }

  impactedRecently(key: number, nowMs: number): boolean {
    const m = this.bodies.get(key);
    return m !== undefined && nowMs - m.lastImpactMs < 1000;
  }

  /**
   * A body's new velocity sample, from the wire. Raises an impact source
   * when it lost enough speed since the previous sample. `radius` is the
   * body's rough extent, to put the contact on its underside.
   */
  noteVelocity(
    key: number, structureId: number, tick: number,
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    mass: number, radius: number, atMs: number, out: DustSourceQueue,
  ): boolean {
    const previous = this.bodies.get(key);
    if (!previous) {
      this.bodies.set(key, { tick, x, y, z, vx, vy, vz, lastImpactMs: -Infinity });
      return false;
    }
    if (tick <= previous.tick) return false;
    const pvx = previous.vx;
    const pvy = previous.vy;
    const pvz = previous.vz;
    previous.tick = tick;
    previous.x = x;
    previous.y = y;
    previous.z = z;
    previous.vx = vx;
    previous.vy = vy;
    previous.vz = vz;
    const speedBefore = Math.hypot(pvx, pvy, pvz);
    if (speedBefore < this.options.minSpeedMps) return false;
    const dvx = vx - pvx;
    const dvy = vy - pvy;
    const dvz = vz - pvz;
    const delta = Math.hypot(dvx, dvy, dvz);
    // Only losing speed counts; a kick that speeds a body up is the other
    // side of someone else's impact.
    const speedAfter = Math.hypot(vx, vy, vz);
    if (delta < this.options.minDeltaMps || speedAfter > speedBefore) return false;
    if (atMs - previous.lastImpactMs < this.options.cooldownMs) return false;
    previous.lastImpactMs = atMs;
    const impulse = mass * delta;
    // The contact is on the side the stop came from: back along Δv.
    const ux = dvx / delta;
    const uy = dvy / delta;
    const uz = dvz / delta;
    const cx = x - ux * radius;
    const cy = Math.max(0.2, y - uy * radius);
    const cz = z - uz * radius;
    const ground = cy < 1.2 && uy > 0.6;
    const s = scratch;
    s.kind = 'impact';
    s.structureId = structureId;
    s.simTick = tick;
    s.ordinal = (this.ordinal = (this.ordinal + 1) & 0xffff);
    s.x = cx;
    s.y = ground ? 0.3 : cy;
    s.z = cz;
    // The contact normal: straight up on the ground, the stopping direction otherwise.
    s.nx = ground ? 0 : ux;
    s.ny = ground ? 1 : uy;
    s.nz = ground ? 0 : uz;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.magnitude = impulse / this.options.impulsePerUnit;
    s.count = 1;
    s.material = 0;
    s.atMs = atMs;
    this.impacts += 1;
    out.push(s);
    this.noteWave(structureId, cx, s.y, cz, impulse, atMs, tick, out);
    return true;
  }

  private noteWave(
    structureId: number, x: number, y: number, z: number, impulse: number,
    atMs: number, tick: number, out: DustSourceQueue,
  ): void {
    const o = this.options;
    const cx = Math.floor(x / o.waveCellM);
    const cz = Math.floor(z / o.waveCellM);
    const key = (cx >= 0 ? cx * 2 : -cx * 2 - 1) * 1048576 + (cz >= 0 ? cz * 2 : -cz * 2 - 1);
    let cell = this.waves.get(key);
    if (!cell || atMs - cell.since > o.waveWindowMs) {
      cell = { impulse: 0, since: atMs, lowestY: Infinity, x: 0, z: 0, count: 0, lastWaveMs: cell?.lastWaveMs ?? -Infinity, structureId };
      this.waves.set(key, cell);
    }
    cell.impulse += impulse;
    cell.count += 1;
    cell.x += x;
    cell.z += z;
    if (y < cell.lowestY) cell.lowestY = y;
    if (cell.impulse < o.waveImpulse || atMs - cell.lastWaveMs < o.waveCooldownMs) return;
    cell.lastWaveMs = atMs;
    const s = scratch;
    s.kind = 'wave';
    s.structureId = structureId;
    s.simTick = tick;
    s.ordinal = (this.ordinal = (this.ordinal + 1) & 0xffff);
    s.x = cell.x / cell.count;
    s.y = Math.max(0.3, cell.lowestY);
    s.z = cell.z / cell.count;
    s.nx = 0;
    s.ny = 1;
    s.nz = 0;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.magnitude = cell.impulse / o.impulsePerUnit;
    s.count = cell.count;
    s.material = 0;
    s.atMs = atMs;
    this.wavesRaised += 1;
    out.push(s);
    cell.impulse = 0;
    cell.count = 0;
    cell.x = 0;
    cell.z = 0;
    cell.lowestY = Infinity;
    if (this.waves.size > 512) {
      for (const [k, c] of this.waves) {
        if (atMs - c.since > o.waveWindowMs * 4) this.waves.delete(k);
      }
    }
  }
}
