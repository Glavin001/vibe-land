import { describe, expect, it } from 'vitest';
import {
  PlayerInterpolator,
  ProjectileInterpolator,
  ServerClockEstimator,
  sampleDynamicBodyTrack,
  type DynamicBodySample,
  type PlayerSample,
} from './interpolation';

// ──────────────────────────────────────────────
// ServerClockEstimator
// ──────────────────────────────────────────────

describe('ServerClockEstimator', () => {
  const TICK_US = Math.round(1_000_000 / 60);

  it('first observation puts server time at the sample', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    expect(clock.getOffsetUs()).toBe(100_000);
    expect(clock.serverNowUs(900_000)).toBe(1_000_000);
  });

  it('runs past the newest sample by at most one snapshot interval', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    // No second snapshot yet: the delay (and so the headroom) is one tick.
    expect(clock.serverNowUs(905_000)).toBe(1_005_000);
    expect(clock.serverNowUs(950_000)).toBe(1_000_000 + TICK_US);
    // A server that stops sending has stopped: the estimate holds.
    expect(clock.serverNowUs(2_000_000)).toBe(1_000_000 + TICK_US);
  });

  it('computes renderTimeUs with interpolation delay', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    expect(clock.renderTimeUs(10_000, 905_000)).toBe(995_000);
  });

  it('getOffsetUs reads the estimate without advancing it', () => {
    const clock = new ServerClockEstimator();
    clock.observe(1_000_000, 900_000);
    clock.serverNowUs(905_000);
    const offset = clock.getOffsetUs();
    expect(clock.getOffsetUs()).toBe(offset);
    expect(clock.serverNowUs(905_000)).toBe(1_005_000);
  });

  it('never goes backwards when samples arrive late and then early', () => {
    const clock = new ServerClockEstimator();
    let last = -Infinity;
    for (let i = 0; i < 600; i += 1) {
      const jitter = (i % 5) * 7_000;
      clock.observe((i + 1) * TICK_US, i * TICK_US + jitter);
      for (let f = 0; f < 2; f += 1) {
        const now = clock.serverNowUs(i * TICK_US + jitter + f * 8_000);
        expect(now).toBeGreaterThanOrEqual(last);
        last = now;
      }
    }
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
    velocity: [number, number, number] = [0, 0, 0],
  ): PlayerSample {
    return {
      serverTimeUs,
      position,
      velocity,
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

  it('extrapolates remote player position using velocity when ahead of latest sample', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(900_000, [0, 0, 0], 0, [4, 0, 0]));
    interp.push(1, makeSample(1_000_000, [1, 0, 0], 0, [4, 0, 0]));

    const sample = interp.sample(1, 1_050_000);
    expect(sample!.position[0]).toBeCloseTo(1.2);
  });

  it('caps remote player extrapolation at 100ms', () => {
    const interp = new PlayerInterpolator();
    interp.push(1, makeSample(900_000, [0, 0, 0], 0, [10, 0, 0]));
    interp.push(1, makeSample(1_000_000, [1, 0, 0], 0, [10, 0, 0]));

    const sample = interp.sample(1, 1_500_000);
    expect(sample!.position[0]).toBeCloseTo(2);
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

// ──────────────────────────────────────────────
// Dynamic body extrapolation
// ──────────────────────────────────────────────

describe('sampleDynamicBodyTrack extrapolation', () => {
  const body = (us: number, position: [number, number, number], velocity: [number, number, number]): DynamicBodySample => ({
    serverTimeUs: us,
    position,
    quaternion: [0, 0, 0, 1],
    halfExtents: [0.3, 0.3, 0.3],
    velocity,
    angularVelocity: [0, 0, 0],
    shapeType: 1,
  });

  it('is ballistic for a body the last two snapshots show in free fall', () => {
    // A cannonball: 20 m/s forward, falling under 9.81 m/s^2.
    const dt = 1 / 60;
    const a = body(0, [0, 10, 0], [20, 0, 0]);
    const b = body(16_667, [20 * dt, 10 - 0.5 * 9.81 * dt * dt, 0], [20, -9.81 * dt, 0]);
    const s = sampleDynamicBodyTrack([a, b], 16_667 + 200_000)!;
    const t = 0.2 + dt;
    expect(s.position[0]).toBeCloseTo(20 * t, 3);
    expect(s.position[1]).toBeCloseTo(10 - 0.5 * 9.81 * t * t, 2);
  });

  it('stays linear for a body at rest or sliding on the ground', () => {
    const a = body(0, [0, 0.3, 0], [2, 0, 0]);
    const b = body(16_667, [2 / 60, 0.3, 0], [2, 0, 0]);
    const s = sampleDynamicBodyTrack([a, b], 16_667 + 200_000)!;
    expect(s.position[1]).toBeCloseTo(0.3, 6);
    expect(s.position[0]).toBeCloseTo(2 / 60 + 0.4, 6);
  });
});
