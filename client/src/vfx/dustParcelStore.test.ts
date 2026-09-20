import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DUST_EVAL_TUNING,
  DUST_SHAPES,
  DustPalette,
  DustParcelStore,
  DustShape,
  evalParcel,
  newDustEval,
  type DustParcel,
} from './dustParcelStore';

const birth = (bornMs: number, over: Partial<DustParcel> = {}): DustParcel => ({
  bornMs, x: 10, y: 2, z: -5, vx: 0, vy: 0, vz: 0, radius0: 1, intensity: 1, seed: 7,
  shape: DustShape.Fracture, palette: DustPalette.Concrete, ...over,
});

describe('DustParcelStore', () => {
  it('is a ring: the oldest is overwritten when full, and counted only if still live', () => {
    const store = new DustParcelStore(3);
    const a = store.spawn(birth(0));
    store.spawn(birth(0));
    store.spawn(birth(0));
    expect(store.liveCount).toBe(3);
    const d = store.spawn(birth(0));
    expect(d).toBe(a);
    expect(store.liveCount).toBe(3);
    expect(store.overwrittenLive).toBe(1);
    expect(store.spawned).toBe(4);
  });

  it('gives every parcel a distinct serial that survives its ring slot being reused', () => {
    const store = new DustParcelStore(2);
    const first = store.serial[store.spawn(birth(0))];
    store.spawn(birth(0));
    const third = store.serial[store.spawn(birth(0))];
    expect(third).not.toBe(first);
    expect(third).toBeGreaterThan(first);
  });

  it('sweeps parcels past their shape lifetime, and counts the rest', () => {
    const store = new DustParcelStore(4);
    store.spawn(birth(0, { shape: DustShape.Fracture }));
    store.spawn(birth(0, { shape: DustShape.Smoulder }));
    store.sweep(DUST_SHAPES[DustShape.Fracture].life * 1000 + 1);
    expect(store.liveCount).toBe(1);
    expect(store.alive[0]).toBe(0);
    expect(store.alive[1]).toBe(1);
  });

  it('keeps a future-born parcel resident but not visible', () => {
    const store = new DustParcelStore(4);
    const slot = store.spawn(birth(1000));
    store.sweep(500);
    expect(store.liveCount).toBe(1);
    const out = newDustEval();
    expect(evalParcel(store, slot, 500, 0, 0, DEFAULT_DUST_EVAL_TUNING, out)).toBe(false);
    expect(evalParcel(store, slot, 1500, 0, 0, DEFAULT_DUST_EVAL_TUNING, out)).toBe(true);
    expect(out.age).toBeCloseTo(0.5);
  });

  it('clear() empties the ring and bumps the generation', () => {
    const store = new DustParcelStore(4);
    store.spawn(birth(0));
    const generation = store.generation;
    store.clear();
    expect(store.liveCount).toBe(0);
    expect(store.head).toBe(0);
    expect(store.generation).toBe(generation + 1);
  });
});

describe('evalParcel', () => {
  it('grows, rises and fades as a function of age alone', () => {
    const store = new DustParcelStore(4);
    const slot = store.spawn(birth(0, { vx: 2 }));
    const early = newDustEval();
    const late = newDustEval();
    evalParcel(store, slot, 500, 0, 0, DEFAULT_DUST_EVAL_TUNING, early);
    evalParcel(store, slot, 6000, 0, 0, DEFAULT_DUST_EVAL_TUNING, late);
    expect(late.radius).toBeGreaterThan(early.radius);
    expect(late.cy).toBeGreaterThan(early.cy);
    expect(late.fade).toBeLessThan(early.fade);
    expect(late.erosion).toBeGreaterThan(early.erosion);
    // The push is spent: the parcel ends up ~vx/drag along x, and no further.
    const curve = DUST_SHAPES[DustShape.Fracture];
    expect(late.cx - 10).toBeLessThanOrEqual(2 / curve.drag + 1e-6);
    expect(late.cx).toBeGreaterThan(early.cx);
    // Same inputs, same answer: nothing in the store moved.
    const again = newDustEval();
    evalParcel(store, slot, 6000, 0, 0, DEFAULT_DUST_EVAL_TUNING, again);
    expect(again).toEqual(late);
  });

  it('is carried by the wind once the push is spent', () => {
    const store = new DustParcelStore(4);
    const slot = store.spawn(birth(0));
    const calm = newDustEval();
    const windy = newDustEval();
    evalParcel(store, slot, 8000, 0, 0, DEFAULT_DUST_EVAL_TUNING, calm);
    evalParcel(store, slot, 8000, 3, 0, DEFAULT_DUST_EVAL_TUNING, windy);
    expect(windy.cx).toBeGreaterThan(calm.cx + 5);
    expect(windy.cz).toBe(calm.cz);
  });

  it('applies the tuning multipliers', () => {
    const store = new DustParcelStore(4);
    const slot = store.spawn(birth(0));
    const base = newDustEval();
    const tuned = newDustEval();
    evalParcel(store, slot, 2000, 0, 0, DEFAULT_DUST_EVAL_TUNING, base);
    evalParcel(store, slot, 2000, 0, 0, { size: 2, density: 0.5, lifetime: 1 }, tuned);
    expect(tuned.radius).toBeCloseTo(base.radius * 2);
    expect(tuned.density).toBeCloseTo(base.density * 0.5);
  });

  it('flattens an impact and starts a smoulder small', () => {
    const store = new DustParcelStore(4);
    const impact = store.spawn(birth(0, { shape: DustShape.Impact }));
    const smoulder = store.spawn(birth(0, { shape: DustShape.Smoulder }));
    const a = newDustEval();
    const b = newDustEval();
    evalParcel(store, impact, 1000, 0, 0, DEFAULT_DUST_EVAL_TUNING, a);
    evalParcel(store, smoulder, 1000, 0, 0, DEFAULT_DUST_EVAL_TUNING, b);
    expect(a.sy / a.sx).toBeLessThan(0.5);
    expect(b.radius).toBeLessThan(a.radius);
  });
});
