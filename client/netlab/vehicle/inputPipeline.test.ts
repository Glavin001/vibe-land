import { describe, expect, it } from 'vitest';
import { SHIPPING, PACED, frames, jitterTarget, simulatePipeline } from './inputPipeline';

// The driven car's input pipeline: every tick the server repeats or skips an
// input the driver predicted is a correction (docs/vehicle-city-measurement.md).
// Live, a weaving drive measured 585-1,493 starved and 300-1,243 collapsed a
// minute; the simulation reproduces that order on loopback with uneven frames.
const LTE = { delayMs: 90, jitterMs: 35, loss: 0.03 }; // netemProfiles.json "lte"
const run = (policy: typeof SHIPPING, seed: number, display = frames(16.667, 0.5)) =>
  simulatePipeline({ seconds: 120, seed, frames: display, uplink: LTE, downlink: LTE, ...policy });

describe('vehicle input pipeline', () => {
  it('shipping mispredicts hundreds of ticks a minute on LTE', () => {
    for (const seed of [1, 2]) expect(run(SHIPPING, seed).mispredictionsPerMin).toBeGreaterThan(600);
  });

  it('paced, inputs apply once each in order: under 1% of ticks mispredicted', () => {
    // 1% of 3,600 ticks a minute; shipping is over 15x that.
    for (const seed of [1, 2]) {
      const paced = run(PACED, seed);
      expect(paced.mispredictionsPerMin).toBeLessThan(36);
      // The price: the queue holds the jitter. A typical input waits no more
      // than the link's one-way delay, its whole jitter spread (90 + 2 x 35
      // ms) and the server's tick phase (one tick).
      expect(paced.delayTicks.p50).toBeLessThan((90 + 70) / (1000 / 60) + 1);
    }
  });

  it("the jitter target does not read the client's paced clock as jitter (as the server)", () => {
    // server vehicle_input_pacing a_client_pacing_its_clock_is_not_jitter.
    const drift = (rate: number) => Array.from({ length: 120 }, (_, i) => [i, 100 + Math.floor(i / rate)] as [number, number]);
    expect(jitterTarget(drift(1.05), 0.95, 120)).toBeLessThanOrEqual(1);
    expect(jitterTarget(drift(0.95), 0.95, 120)).toBeLessThanOrEqual(1);
    // The first version did: 5 ticks of queue for none of jitter.
    expect(jitterTarget(drift(1.05), 0.95, Infinity)).toBe(5);
  });

  it('paced holds with display hitches', () => {
    const hitchy = frames(16.667, 1, 0.02, 80);
    for (const seed of [1, 2]) expect(run(PACED, seed, hitchy).mispredictionsPerMin).toBeLessThan(36);
  });
});
