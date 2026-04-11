import { describe, expect, it } from 'vitest';
import {
  PlayerInterpolator,
  ProjectileInterpolator,
  ServerClockEstimator,
  type PlayerSample,
} from './interpolation';

// ──────────────────────────────────────────────
// ServerClockEstimator
// ──────────────────────────────────────────────

describe('ServerClockEstimator', () => {
  it('first observation sets offset directly', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    expect(clock.getOffsetUs()).toBe(100_000);
  });

  it('computes serverNowUs from observed offset', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000); // offset = 100_000
    expect(clock.serverNowUs(950_000)).toBe(1_050_000);
  });

  it('computes renderTimeUs with interpolation delay', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    expect(clock.renderTimeUs(100_000, 950_000)).toBe(950_000);
  });

  it('moves toward higher offset via EMA', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000); // offset = 100_000
    clock.observe(1_200_000, 900_000); // sample offset = 300_000

    // Symmetric EMA: 100_000 * 0.9 + 300_000 * 0.1 = 120_000
    expect(clock.getOffsetUs()).toBe(120_000);
  });

  it('moves toward lower offset via EMA', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000); // offset = 100_000

    // Observe a lower offset
    clock.observe(1_000_000, 920_000); // sample offset = 80_000

    // Symmetric EMA: 100_000 * 0.9 + 80_000 * 0.1 = 98_000
    const offset = clock.getOffsetUs();
    expect(offset).toBeCloseTo(98_000, -2);
  });

  it('eventually converges after many lower observations', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000); // offset = 100_000

    // Many observations with lower offset
    for (let i = 0; i < 200; i++) {
      clock.observe(1_000_000, 950_000); // sample offset = 50_000
    }

    // Should have converged close to 50_000
    const offset = clock.getOffsetUs();
    expect(offset).toBeLessThan(55_000);
    expect(offset).toBeGreaterThan(45_000);
  });
});

// ──────────────────────────────────────────────
// PlayerInterpolator
// ──────────────────────────────────────────────

describe('PlayerInterpolator', () => {
  function makeSample(
    serverTimeUs: number,
    position: [number, number, number],
    yaw = 0,
  ): PlayerSample {
    return {
      serverTimeUs,
      position,
      velocity: [0, 0, 0],
      yaw,
      pitch: 0,
      hp: 100,
      flags: 0,
    };
  }

  it('interpolates between two samples at midpoint', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [0, 1, 0]));
    interp.push(1, makeSample(1_100_000, [10, 1, 0]));

    const sample = interp.sample(1, 1_050_000);
    expect(sample).not.toBeNull();
    expect(sample!.position[0]).toBeCloseTo(5);
    expect(sample!.position[1]).toBeCloseTo(1);
  });

  it('interpolates at 25% alpha', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [0, 0, 0]));
    interp.push(1, makeSample(1_100_000, [100, 0, 0]));

    const sample = interp.sample(1, 1_025_000);
    expect(sample!.position[0]).toBeCloseTo(25);
  });

  it('returns earliest sample when target is before all samples', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [5, 0, 0]));
    interp.push(1, makeSample(1_100_000, [10, 0, 0]));

    const sample = interp.sample(1, 500_000);
    expect(sample!.position[0]).toBeCloseTo(5);
  });

  it('returns latest sample when target is after all samples', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [5, 0, 0]));
    interp.push(1, makeSample(1_100_000, [10, 0, 0]));

    const sample = interp.sample(1, 2_000_000);
    expect(sample!.position[0]).toBeCloseTo(10);
  });

  it('handles exactly matching timestamps', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [5, 0, 0]));
    interp.push(1, makeSample(1_000_000, [10, 0, 0]));

    const sample = interp.sample(1, 1_000_000);
    expect(sample).not.toBeNull();
    // With equal timestamps the early-return path fires (targetTimeUs <= queue[0]),
    // returning the first sample. This is acceptable behavior.
    expect(sample!.position[0]).toBeCloseTo(5);
  });

  it('interpolates angles correctly (short arc)', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [0, 0, 0], 0));
    interp.push(1, makeSample(1_100_000, [0, 0, 0], Math.PI / 2));

    const sample = interp.sample(1, 1_050_000);
    expect(sample!.yaw).toBeCloseTo(Math.PI / 4);
  });

  it('interpolates angles across wraparound (350° → 10°)', () => {
    const interp = new PlayerInterpolator();
    const deg350 = (350 / 180) * Math.PI;
    const deg10 = (10 / 180) * Math.PI;
    interp.push(1, makeSample(1_000_000, [0, 0, 0], deg350));
    interp.push(1, makeSample(1_100_000, [0, 0, 0], deg10));

    const sample = interp.sample(1, 1_050_000);
    // Should interpolate through 0/360, not backwards through 180
    const resultDeg = (sample!.yaw * 180) / Math.PI;
    // At midpoint: should be near 0° (360°) or equivalently near 0
    expect(resultDeg % 360).toBeLessThan(15);
  });

  it('evicts oldest when exceeding max samples', () => {
    const interp = new PlayerInterpolator(4); // max 4 samples
    for (let i = 0; i < 6; i++) {
      interp.push(1, makeSample(i * 100_000, [i, 0, 0]));
    }

    // Oldest samples (0, 1) should be evicted
    // Querying at time 0 should return the earliest remaining sample
    const sample = interp.sample(1, 0);
    expect(sample!.position[0]).toBeCloseTo(2); // samples 2,3,4,5 remain
  });

  it('retainOnly removes unlisted players', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [0, 0, 0]));
    interp.push(2, makeSample(1_000_000, [1, 0, 0]));
    interp.push(3, makeSample(1_000_000, [2, 0, 0]));

    interp.retainOnly(new Set([2]));

    expect(interp.sample(1, 1_000_000)).toBeNull();
    expect(interp.sample(2, 1_000_000)).not.toBeNull();
    expect(interp.sample(3, 1_000_000)).toBeNull();
  });

  it('returns null for unknown entity', () => {
    const interp = new PlayerInterpolator();
    expect(interp.sample(999, 1_000_000)).toBeNull();
  });

  it('remove() deletes a specific entity', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(1_000_000, [5, 0, 0]));

    interp.remove(1);
    expect(interp.sample(1, 1_000_000)).toBeNull();
  });

  it('ids() returns all tracked entity IDs', () => {
    const interp = new PlayerInterpolator();
    interp.push(10, makeSample(1_000_000, [0, 0, 0]));
    interp.push(20, makeSample(1_000_000, [0, 0, 0]));

    const ids = interp.ids();
    expect(ids).toContain(10);
    expect(ids).toContain(20);
    expect(ids).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────
// ProjectileInterpolator
// ──────────────────────────────────────────────

describe('ProjectileInterpolator', () => {
  function makeSample(
    serverTimeUs: number,
    position: [number, number, number],
    velocity: [number, number, number] = [0, 0, 0],
  ) {
    return {
      serverTimeUs,
      position,
      velocity,
      kind: 1,
      ownerId: 1,
      sourceShotId: 1,
    };
  }

  it('interpolates between two samples', () => {
    const interp = new ProjectileInterpolator();
    interp.push(1, makeSample(1_000_000, [0, 0, 0]));
    interp.push(1, makeSample(1_100_000, [10, 0, 0]));

    const sample = interp.sample(1, 1_050_000);
    expect(sample!.position[0]).toBeCloseTo(5);
  });

  it('extrapolates using velocity when ahead of latest sample', () => {
    const interp = new ProjectileInterpolator();
    // Need at least 2 samples to reach the extrapolation path
    // (single-sample early-return fires before extrapolation)
    interp.push(1, makeSample(900_000, [0, 0, 0], [10, 0, 0]));
    interp.push(1, makeSample(1_000_000, [1, 0, 0], [10, 0, 0]));

    // 50ms after latest sample → extrapolate 0.05s * 10m/s = 0.5m from pos 1
    const sample = interp.sample(1, 1_050_000);
    expect(sample!.position[0]).toBeCloseTo(1.5);
  });

  it('caps extrapolation at 150ms', () => {
    const interp = new ProjectileInterpolator();
    interp.push(1, makeSample(900_000, [0, 0, 0], [100, 0, 0]));
    interp.push(1, makeSample(1_000_000, [10, 0, 0], [100, 0, 0]));

    // 300ms after latest sample → capped at 150ms
    const sample = interp.sample(1, 1_300_000);
    // 0.15s * 100m/s = 15m from pos 10
    expect(sample!.position[0]).toBeCloseTo(25);
  });

  it('does not extrapolate backwards', () => {
    const interp = new ProjectileInterpolator();
    interp.push(1, makeSample(1_000_000, [5, 0, 0], [10, 0, 0]));

    // Before the sample → return sample position, no backward extrapolation
    const sample = interp.sample(1, 500_000);
    expect(sample!.position[0]).toBeCloseTo(5);
  });

  it('returns null for unknown entity', () => {
    const interp = new ProjectileInterpolator();
    expect(interp.sample(999, 1_000_000)).toBeNull();
  });
});
