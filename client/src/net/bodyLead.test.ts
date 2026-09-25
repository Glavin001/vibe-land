import { describe, expect, it } from 'vitest';

import { BodyLeadHorizon, BodyLeadTrack, inFreeFall, type BodyLeadConfig } from './bodyLead';
import { sampleDynamicBodyTrack, type DynamicBodySample } from './interpolation';
import { SERVER_TICK_US } from './protocol';

const TICK = SERVER_TICK_US;
const G = -9.81;

const config = (over: Partial<BodyLeadConfig> = {}): BodyLeadConfig => ({
  enabled: true,
  backoffTicks: 0,
  capTicks: 1,
  maxOvershootM: 0,
  maxLeadTicks: 6,
  rise: 0.5,
  fall: 0.5,
  warp: true,
  horizonTauMs: 500,
  horizonMode: 'arrival',
  quantile: 0.1,
  window: 120,
  warpGain: 0.8,
  ...over,
});

/** A ball thrown at `v0` from `p0` at tick `t0`, sampled at tick `tick`. */
function thrown(tick: number, p0: [number, number, number], v0: [number, number, number], t0 = 0): DynamicBodySample {
  const t = ((tick - t0) * TICK) / 1e6;
  return {
    serverTimeUs: tick * TICK,
    position: [p0[0] + v0[0] * t, p0[1] + v0[1] * t + 0.5 * G * t * t, p0[2] + v0[2] * t],
    quaternion: [0, 0, 0, 1],
    halfExtents: [0.2, 0.2, 0.2],
    velocity: [v0[0], v0[1] + G * t, v0[2]],
    angularVelocity: [0, 0, 0],
    shapeType: 0,
  };
}

function rolling(tick: number): DynamicBodySample {
  const t = (tick * TICK) / 1e6;
  return { ...thrown(tick, [0, 0.2, 0], [3, 0, 0]), position: [3 * t, 0.2, 0], velocity: [3, 0, 0] };
}

describe('BodyLeadHorizon', () => {
  it('follows how far the newest snapshot runs ahead of the render time, less the back-off', () => {
    const horizon = new BodyLeadHorizon(config());
    for (let k = 0; k < 120; k += 1) horizon.observeArrival(k * TICK, k * TICK - 15_000, k * 16_667);
    expect(horizon.horizonUs()).toBeCloseTo(15_000, -1);
    const backedOff = new BodyLeadHorizon(config({ backoffTicks: 0.5 }));
    for (let k = 0; k < 120; k += 1) backedOff.observeArrival(k * TICK, k * TICK - 15_000, k * 16_667);
    expect(backedOff.horizonUs()).toBeCloseTo(15_000 - 0.5 * TICK, -1);
  });

  it('is 0 when off, never negative, and at most maxLeadTicks', () => {
    const off = new BodyLeadHorizon(config({ enabled: false }));
    off.observeArrival(1_000_000, 900_000, 0);
    expect(off.horizonUs()).toBe(0);
    const behind = new BodyLeadHorizon(config());
    behind.observeArrival(1_000_000, 1_010_000, 0);
    expect(behind.horizonUs()).toBe(0);
    const far = new BodyLeadHorizon(config({ maxLeadTicks: 2 }));
    far.observeArrival(1_000_000, 500_000, 0);
    expect(far.horizonUs()).toBe(2 * TICK);
  });
});

describe('BodyLeadTrack', () => {
  const horizonUs = 15_000;
  const drive = (samplesAt: (tick: number) => DynamicBodySample[], ticks: number, cfg = config()) => {
    const track = new BodyLeadTrack();
    const leads: number[] = [];
    const draws: number[] = [];
    for (let frame = 0; frame < ticks * 2; frame += 1) {
      const renderUs = 100 * TICK + (frame * TICK) / 2;
      const samples = samplesAt(Math.floor(renderUs / TICK) + 1);
      const drawUs = track.advance(renderUs, samples, horizonUs, cfg, (t) => sampleDynamicBodyTrack(samples, t)!.position);
      track.drawn(sampleDynamicBodyTrack(samples, drawUs)!.position);
      leads.push(track.lead);
      draws.push(drawUs);
    }
    return { leads, draws };
  };
  const ballistic = (newest: number) => [newest - 3, newest - 2, newest - 1, newest].map((k) => thrown(k, [0, 50, 0], [20, 5, 0]));

  it('a free-falling body takes the horizon as playback speed, starting from no lead', () => {
    const { leads, draws } = drive(ballistic, 60);
    expect(leads[0]).toBe(0);
    for (let i = 1; i < leads.length; i += 1) {
      // Half a frame of render time per frame: the lead moves at most 0.5 of it.
      expect(Math.abs(leads[i] - leads[i - 1])).toBeLessThanOrEqual(0.5 * (TICK / 2) + 1e-6);
      expect(draws[i]).toBeGreaterThan(draws[i - 1]);
    }
    expect(leads[leads.length - 1]).toBeCloseTo(horizonUs, 0);
  });

  it('gives its lead up once the render time nears its newest sample plus capTicks', () => {
    // The stream stops carrying the body after tick 110 (starved, or late):
    // the goal falls to what the cap allows, and the lead follows it down at
    // the fall rate (the body slows to half speed, it does not stop).
    const cfg = config({ capTicks: 0.25 });
    const stale = (newest: number) => ballistic(Math.min(newest, 110));
    const { leads, draws } = drive(stale, 60, cfg);
    const renderAt = (i: number) => 100 * TICK + (i * TICK) / 2;
    for (let i = 0; i < leads.length; i += 1) {
      if (renderAt(i) >= 110 * TICK + 0.25 * TICK + 2 * TICK * 2) expect(leads[i]).toBe(0);
      if (i > 0) expect(draws[i] - draws[i - 1]).toBeGreaterThanOrEqual(0.5 * (TICK / 2) - 1e-6);
    }
  });

  it('a body not in free fall keeps no lead', () => {
    const { leads } = drive((newest) => [newest - 1, newest].map(rolling), 30);
    expect(Math.max(...leads)).toBe(0);
    expect(inFreeFall([rolling(1), rolling(2)])).toBe(false);
    expect(inFreeFall([thrown(1, [0, 9, 0], [1, 0, 0]), thrown(2, [0, 9, 0], [1, 0, 0])])).toBe(true);
  });

  it('a contact inside the lead is met in time, not with a jump', () => {
    // A ball dropped from 12 m bounces on y = 0.2 (the server steps it per
    // tick). Samples reach the client a tick ahead of the render time; the
    // horizon is three ticks and the cap two, so the ball is drawn up to two
    // ticks past its newest sample and runs through the floor until the
    // bounce's sample arrives.
    const ticks: DynamicBodySample[] = [];
    let y = 12;
    let vy = 0;
    const dt = TICK / 1e6;
    for (let k = 0; k < 400; k += 1) {
      vy += G * dt;
      y += vy * dt;
      if (y < 0.2) {
        y = 0.2;
        vy = -0.8 * vy;
      }
      ticks.push({ ...thrown(k, [0, 0, 0], [0, 0, 0]), position: [0, y, 0], velocity: [0, vy, 0] });
    }
    const run = (warp: boolean) => {
      const track = new BodyLeadTrack();
      const counters = { warps: 0, warpedMs: 0 };
      let maxStep = 0;
      let last: number[] | null = null;
      for (let frame = 0; frame < 700; frame += 1) {
        const renderUs = (frame * TICK) / 2;
        const newest = Math.min(ticks.length - 1, Math.floor(renderUs / TICK) + 1);
        const samples = ticks.slice(Math.max(0, newest - 8), newest + 1);
        const drawUs = track.advance(renderUs, samples, 3 * TICK, config({ warp, capTicks: 2 }),
          (t) => sampleDynamicBodyTrack(samples, t)!.position, counters);
        const p = sampleDynamicBodyTrack(samples, drawUs)!.position;
        track.drawn(p);
        if (last) maxStep = Math.max(maxStep, Math.abs(p[1] - last[1]));
        last = [...p];
      }
      return { maxStep, counters };
    };
    const withWarp = run(true);
    const without = run(false);
    expect(withWarp.counters.warps).toBeGreaterThan(0);
    expect(without.counters.warps).toBe(0);
    // The fastest the ball falls is ~15 m/s: 0.13 m per half-tick frame. The
    // unmet overshoot is a jump of several times that.
    expect(without.maxStep).toBeGreaterThan(0.25);
    expect(withWarp.maxStep).toBeLessThan(without.maxStep * 0.7);
  });

  it('with no lead (off) it returns the render time exactly', () => {
    const track = new BodyLeadTrack();
    for (let frame = 0; frame < 30; frame += 1) {
      const r = 100 * TICK + frame * 8_000;
      const samples = ballistic(Math.floor(r / TICK) + 1);
      expect(track.advance(r, samples, 0, config(), () => null)).toBe(r);
    }
  });
});
