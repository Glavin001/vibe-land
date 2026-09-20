import { describe, expect, it } from 'vitest';

import { DustPalette, DustParcelStore, DustShape, DEFAULT_DUST_EVAL_TUNING, evalParcel, newDustEval } from './dustParcelStore';
import { DustMovers } from './dustMovers';

describe('DustMovers.pushParcels', () => {
  it('carries a parcel with a body passing through it and shoves it aside', () => {
    const store = new DustParcelStore(8);
    const slot = store.spawn({ bornMs: 0, x: 0, y: 3, z: 0, vx: 0, vy: 0, vz: 0, radius0: 1, intensity: 1, seed: 1, shape: DustShape.Fracture, palette: DustPalette.Concrete });
    const far = store.spawn({ bornMs: 0, x: 40, y: 3, z: 0, vx: 0, vy: 0, vz: 0, radius0: 1, intensity: 1, seed: 2, shape: DustShape.Fracture, palette: DustPalette.Concrete });
    const movers = new DustMovers();
    movers.movers.push({ key: 1, x: -0.5, y: 3, z: 0, vx: 10, vy: 0, vz: 0, speed: 10, radius: 2, mass: 1000 });
    movers.pushParcels(store, 0.05);
    expect(store.ox[slot]).toBeGreaterThan(0.05); // carried along +x and shoved away (+x)
    expect(store.ox[slot]).toBeLessThan(0.5); // but bounded: parted, not erased
    expect(store.ox[far]).toBe(0);
    const e = newDustEval();
    evalParcel(store, slot, 1000, 0, 0, DEFAULT_DUST_EVAL_TUNING, e);
    expect(e.cx).toBeCloseTo(store.ox[slot]);
  });

  it('respects the room when pushed', () => {
    const store = new DustParcelStore(8);
    const clearance = new Float32Array([16, 1, 16, 16, 16, 16]); // wall 1 m to +x
    const slot = store.spawn({ bornMs: 0, x: 0, y: 3, z: 0, vx: 0, vy: 0, vz: 0, radius0: 0.5, intensity: 1, seed: 1, shape: DustShape.Fracture, palette: DustPalette.Concrete, clearance });
    const movers = new DustMovers();
    movers.movers.push({ key: 1, x: -0.5, y: 3, z: 0, vx: 20, vy: 0, vz: 0, speed: 20, radius: 2, mass: 1000 });
    for (let i = 0; i < 20; i += 1) movers.pushParcels(store, 0.05);
    const e = newDustEval();
    evalParcel(store, slot, 100, 0, 0, DEFAULT_DUST_EVAL_TUNING, e);
    expect(e.cx + e.sx / 2).toBeLessThanOrEqual(1 + 1e-4);
  });
});
