import { describe, expect, it } from 'vitest';
import { PlayerInterpolator, ServerClockEstimator } from './interpolation';

describe('PlayerInterpolator', () => {
  it('interpolates between server-time samples', () => {
    const interpolator = new PlayerInterpolator();
    interpolator.push(7, {
      serverTimeUs: 1_000_000,
      position: [0, 1, 0],
      velocity: [0, 0, 1],
      yaw: 0,
      pitch: 0,
      flags: 1,
    });
    interpolator.push(7, {
      serverTimeUs: 1_100_000,
      position: [10, 1, 0],
      velocity: [0, 0, 1],
      yaw: Math.PI / 2,
      pitch: 0,
      flags: 1,
    });

    const sample = interpolator.sample(7, 1_050_000);
    expect(sample).not.toBeNull();
    expect(sample?.position[0]).toBeCloseTo(5);
    expect(sample?.position[1]).toBeCloseTo(1);
    expect(sample?.yaw).toBeCloseTo(Math.PI / 4);
  });

  it('retains only active ids', () => {
    const interpolator = new PlayerInterpolator();
    interpolator.push(1, {
      serverTimeUs: 1,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      flags: 0,
    });
    interpolator.push(2, {
      serverTimeUs: 2,
      position: [1, 0, 0],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      flags: 0,
    });

    interpolator.retainOnly(new Set([2]));

    expect(interpolator.sample(1, 2)).toBeNull();
    expect(interpolator.sample(2, 2)?.position[0]).toBe(1);
  });
});

describe('ServerClockEstimator', () => {
  it('computes render time from observed offset', () => {
    const clock = new ServerClockEstimator();

    clock.observe(1_000_000, 900_000);

    expect(clock.serverNowUs(950_000)).toBe(1_050_000);
    expect(clock.renderTimeUs(100_000, 950_000)).toBe(950_000);
  });
});
