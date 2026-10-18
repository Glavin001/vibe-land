import { describe, expect, it } from 'vitest';

import { DustPalette, DustParcelStore, DustShape } from '../vfx/dustParcelStore';
import type { DustSource } from './destructionEvents';
import { DustPolicy, hash32, paletteFromAppearance } from './dustPolicy';

const source = (over: Partial<DustSource> = {}): DustSource => ({
  kind: 'fracture', structureId: 1, simTick: 100, ordinal: 0, x: 10, y: 5, z: -3,
  nx: 0, ny: 0, nz: 1, vx: 0, vy: 0, vz: 0, magnitude: 18, count: 10, material: 0, atMs: 1000,
  ...over,
});

function policy(store = new DustParcelStore(512)) {
  return { store, policy: new DustPolicy(store, () => DustPalette.Concrete) };
}

describe('DustPolicy', () => {
  it('makes more, bigger, thicker dust for a bigger break, sub-linearly', () => {
    const ten = policy();
    const n10 = ten.policy.emit(source({ magnitude: 18 }));
    const hundred = policy();
    const n100 = hundred.policy.emit(source({ magnitude: 180 }));
    expect(n100).toBeGreaterThan(n10);
    expect(n100).toBeLessThan(n10 * 10);
    expect(hundred.store.radius0[0]).toBeGreaterThan(ten.store.radius0[0]);
    expect(hundred.store.intensity[0]).toBeGreaterThan(ten.store.intensity[0]);
    const thousand = policy();
    expect(thousand.policy.emit(source({ magnitude: 1800 }))).toBe(8);
  });

  it('clamps the radius', () => {
    const tiny = policy();
    tiny.policy.emit(source({ magnitude: 0.01 }));
    expect(tiny.store.radius0[0]).toBeGreaterThanOrEqual(0.5 * 0.8);
    const huge = policy();
    huge.policy.emit(source({ magnitude: 1e6 }));
    expect(huge.store.radius0[0]).toBeLessThanOrEqual(4 * 1.2);
  });

  it('holds the per-tick cap and resets it on the next tick', () => {
    const { policy: p } = policy();
    let spawned = 0;
    for (let i = 0; i < 10; i += 1) spawned += p.emit(source({ ordinal: i, magnitude: 1800 }));
    expect(spawned).toBe(32);
    expect(p.stats.droppedByTickCap).toBe(80 - 32);
    expect(p.emit(source({ simTick: 101, magnitude: 1800 }))).toBe(8);
  });

  it('is deterministic for the same source', () => {
    const a = policy();
    const b = policy();
    a.policy.emit(source());
    b.policy.emit(source());
    expect(Array.from(a.store.px)).toEqual(Array.from(b.store.px));
    expect(Array.from(a.store.vz)).toEqual(Array.from(b.store.vz));
    expect(Array.from(a.store.seed)).toEqual(Array.from(b.store.seed));
    // A different ordinal is a different cloud.
    const c = policy();
    c.policy.emit(source({ ordinal: 1 }));
    expect(Array.from(c.store.px)).not.toEqual(Array.from(a.store.px));
  });

  it('starts a fracture outside the face and throws it along the normal', () => {
    const { store, policy: p } = policy();
    const n = p.emit(source({ nx: 0, ny: 0, nz: 1, magnitude: 1800 }));
    expect(n).toBe(8);
    let sumZ = 0;
    for (let i = 0; i < n; i += 1) {
      sumZ += store.pz[i];
      // Never thrown back into the wall: the normal push matches the scatter.
      expect(store.vz[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(store.shape[i]).toBe(DustShape.Fracture);
    }
    // Centred 0.4 m out along the normal, scattered up to 0.6·radius0 around it.
    expect(Math.abs(sumZ / n - (-3 + 0.4))).toBeLessThan(0.6 * 4 * 1.2);
  });

  it('spreads an impact flat and outward', () => {
    const { store, policy: p } = policy();
    const n = p.emit(source({ kind: 'impact', y: 0.3, nx: 0, ny: 1, nz: 0, magnitude: 30 }));
    for (let i = 0; i < n; i += 1) {
      expect(store.shape[i]).toBe(DustShape.Impact);
      expect(store.vy[i]).toBeCloseTo(0);
      expect(Math.hypot(store.vx[i], store.vz[i])).toBeGreaterThanOrEqual(1.5);
      expect(store.py[i]).toBeCloseTo(0.3 + 0.4 + 0.2);
    }
  });

  it('makes no dust of glass', () => {
    const store = new DustParcelStore(64);
    const p = new DustPolicy(store, (m) => (m === 2 ? DustPalette.None : DustPalette.Concrete));
    expect(p.emit(source({ material: 2 }))).toBe(0);
    expect(p.stats.droppedByPalette).toBe(1);
    expect(p.emit(source({ material: 0 }))).toBeGreaterThan(0);
  });

  it('keeps a broken cell smouldering for a while, then stops', () => {
    const { store, policy: p } = policy();
    const burst = p.emit(source({ atMs: 1000 }));
    p.tick(1000);
    expect(store.spawned).toBe(burst);
    p.tick(1400);
    expect(store.spawned).toBe(burst + 1);
    expect(store.shape[burst]).toBe(DustShape.Smoulder);
    p.tick(1800);
    expect(store.spawned).toBe(burst + 2);
    // Fed again: keeps going past the original hold.
    p.emit(source({ simTick: 150, atMs: 2400 }));
    p.tick(3800);
    const before = store.spawned;
    p.tick(4500);
    expect(store.spawned).toBe(before);
    expect(p.stats.smoulderCells).toBe(0);
  });

  it('tracks at most the configured number of smouldering cells', () => {
    const { policy: p } = policy();
    for (let i = 0; i < 20; i += 1) p.emit(source({ ordinal: i, x: i * 10, magnitude: 5 }));
    p.tick(1000);
    expect(p.stats.smoulderCells).toBe(16);
  });

  it('catches up boundedly after a stall', () => {
    const { store, policy: p } = policy();
    const burst = p.emit(source({ atMs: 0 }));
    p.tick(1400); // 4 intervals late; at most ~2 parcels, not 4
    expect(store.spawned - burst).toBeLessThanOrEqual(2);
  });
});

describe('entry and wave shapes', () => {
  it('jets an entry along its normal, fast', () => {
    const { store, policy: p } = policy();
    const n = p.emit(source({ kind: 'entry', nx: 0, ny: 0, nz: -1, magnitude: 40 }));
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) {
      expect(store.shape[i]).toBe(DustShape.Entry);
      expect(store.vz[i]).toBeLessThan(-3);
    }
  });

  it('rings a wave around the front and throws it outward', () => {
    const { store, policy: p } = policy();
    const n = p.emit(source({ kind: 'wave', x: 0, y: 0.3, z: 0, nx: 0, ny: 1, nz: 0, magnitude: 50 }));
    expect(n).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < n; i += 1) {
      expect(store.shape[i]).toBe(DustShape.Wave);
      // Velocity points away from the centre.
      const dot = store.px[i] * store.vx[i] + store.pz[i] * store.vz[i];
      expect(dot).toBeGreaterThan(0);
      expect(Math.hypot(store.vx[i], store.vz[i])).toBeGreaterThanOrEqual(5);
    }
  });

  it('puts a fracture on the open side of its face', () => {
    const { store, policy: p } = policy();
    // Room on −z only: +z of the face is inside a chunk.
    p.clearanceOf = (_x, _y, z, out) => { out.fill(8); if (z > 0) { out[4] = 0; out[5] = 0; } };
    const n = p.emit(source({ x: 0, y: 2, z: 0, nx: 0, ny: 0, nz: 1, magnitude: 20 }));
    for (let i = 0; i < n; i += 1) expect(store.pz[i]).toBeLessThan(0.5);
  });

  it('measures the room for every parcel it spawns', () => {
    const { store, policy: p } = policy();
    p.clearanceOf = (_x, _y, _z, out) => { out.fill(2); };
    p.emit(source({ magnitude: 5 }));
    expect(store.clearance[0]).toBe(2);
    expect(store.clearance[5]).toBe(2);
  });
});

describe('paletteFromAppearance', () => {
  it('reads the material name', () => {
    const table = [{ name: 'Concrete' }, { name: 'Window glass' }, { textureKey: 'timber_planks' }, { name: 'Steel girder' }];
    expect(paletteFromAppearance(table, 0)).toBe(DustPalette.Concrete);
    expect(paletteFromAppearance(table, 1)).toBe(DustPalette.None);
    expect(paletteFromAppearance(table, 2)).toBe(DustPalette.Wood);
    expect(paletteFromAppearance(table, 3)).toBe(DustPalette.Metal);
    expect(paletteFromAppearance(undefined, 5)).toBe(DustPalette.Concrete);
  });
});

describe('hash32', () => {
  it('is stable and spreads', () => {
    expect(hash32(1, 2, 3, 4)).toBe(hash32(1, 2, 3, 4));
    expect(hash32(1, 2, 3, 4)).not.toBe(hash32(1, 2, 3, 5));
    expect(hash32(0, 0, 0, 0)).not.toBe(hash32(0, 0, 0, 1));
  });
});
