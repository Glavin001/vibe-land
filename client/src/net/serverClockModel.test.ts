import { describe, expect, it } from 'vitest';
import { initWasmForTests } from '../wasm/testInit';
import { WasmClockSync } from '../wasm/pkg/vibe_land_shared.js';
import { RenderClock } from './interpolation';
import {
  MAX_CATCH_UP,
  MAX_DELAY_US,
  TsServerClock,
  type ServerClockModel,
} from './serverClockModel';

const TICK_US = 16_667;

type Trace = {
  /** Server wall time each snapshot is sent at, us. Snapshot i carries tick i + 1. */
  sends: number[];
  latencyUs: (i: number) => number;
  wall: boolean;
};

type Frame = { local: number; now: number; newest: number; delayUs: number };

/** Feed a trace into a model, reading the clock at 120 Hz. */
function run(model: ServerClockModel, trace: Trace): Frame[] {
  const events = trace.sends
    .map((sent, i) => ({ arrive: sent + trace.latencyUs(i), server: (i + 1) * TICK_US, sent }))
    .sort((a, b) => a.arrive - b.arrive);
  const frames: Frame[] = [];
  let next = 0;
  let newest = 0;
  const end = events[events.length - 1].arrive;
  for (let t = events[0].arrive; t <= end; t += 8_333) {
    while (next < events.length && events[next].arrive <= t) {
      const e = events[next++];
      if (trace.wall) {
        model.observeServerTimeWithWall(e.server, Math.max(0, e.sent) % 2 ** 32, e.arrive);
      } else {
        model.observeServerTime(e.server, e.arrive);
      }
      newest = Math.max(newest, e.server);
    }
    frames.push({ local: t, now: model.serverNowUs(t), newest, delayUs: model.getInterpolationDelayMs() * 1000 });
  }
  return frames;
}

function backwardSteps(frames: Frame[]): number {
  let n = 0;
  for (let i = 1; i < frames.length; i += 1) if (frames[i].now < frames[i - 1].now) n += 1;
  return n;
}

function playoutRate(frames: Frame[], fromUs: number, toUs: number): number {
  const a = frames.find((f) => f.local >= fromUs)!;
  const b = [...frames].reverse().find((f) => f.local <= toUs)!;
  return (b.now - a.now) / (b.local - a.local);
}

const steady60: Trace = { sends: Array.from({ length: 600 }, (_, i) => i * TICK_US), latencyUs: () => 2_000, wall: false };
const slow35: Trace = { sends: Array.from({ length: 700 }, (_, i) => (i * 1e6) / 35), latencyUs: () => 1_000, wall: false };

/** 20-60 Hz, changing every wall second, and a 500 ms stall every 120 ticks. */
function varyingSends(): number[] {
  let t = 0;
  const sends: number[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const hz = [60, 20, 45, 30, 55, 25][Math.floor(t / 1e6) % 6];
    t += 1e6 / hz;
    if (i % 120 === 119) t += 500_000;
    sends.push(t);
  }
  return sends;
}
const varying: Trace = { sends: varyingSends(), latencyUs: (i) => 1_000 + (i % 7) * 1_500, wall: false };

describe('TsServerClock', () => {
  it('steady 60 Hz: rate 1, delay one tick, never past the newest snapshot', () => {
    const clock = new TsServerClock(60);
    const frames = run(clock, steady60);
    expect(backwardSteps(frames)).toBe(0);
    expect(clock.getRate()).toBeCloseTo(1, 2);
    expect(playoutRate(frames, 3e6, 9.5e6)).toBeCloseTo(1, 2);
    expect(clock.getInterpolationDelayMs()).toBeGreaterThanOrEqual(16.6);
    expect(clock.getInterpolationDelayMs()).toBeLessThan(20);
    const ahead = frames.slice(60).filter((f) => f.now - f.delayUs > f.newest + 1);
    expect(ahead).toHaveLength(0);
  });

  it('a 35 Hz server: measures the 0.58x rate and plays out at it', () => {
    for (const wall of [false, true]) {
      const clock = new TsServerClock(60);
      const frames = run(clock, { ...slow35, wall });
      const expected = (35 * TICK_US) / 1e6;
      expect(backwardSteps(frames)).toBe(0);
      expect(Math.abs(clock.getRate() - expected) / expected).toBeLessThan(0.02);
      expect(Math.abs(playoutRate(frames, 5e6, 19e6) - expected) / expected).toBeLessThan(0.02);
    }
  });

  it('20-60 Hz with 500 ms stalls: monotonic, no snaps, never far ahead of the stream', () => {
    for (const wall of [false, true]) {
      const clock = new TsServerClock(60);
      const frames = run(clock, { ...varying, wall });
      expect(backwardSteps(frames)).toBe(0);
      let maxStepRate = 0;
      for (let i = 1; i < frames.length; i += 1) {
        maxStepRate = Math.max(maxStepRate, (frames[i].now - frames[i - 1].now) / (frames[i].local - frames[i - 1].local));
      }
      // Bounded correction: nothing faster than the catch-up limit at the highest plausible rate.
      expect(maxStepRate).toBeLessThanOrEqual(2 * MAX_CATCH_UP + 1e-9);
      const worstAhead = Math.max(...frames.slice(120).map((f) => f.now - f.newest));
      expect(worstAhead).toBeLessThanOrEqual(MAX_DELAY_US + 1);
    }
  });

  it('a 600 ms stall freezes the clock instead of running ahead', () => {
    const sends = Array.from({ length: 400 }, (_, i) => i * TICK_US + (i >= 200 ? 600_000 : 0));
    const clock = new TsServerClock(60);
    const frames = run(clock, { sends, latencyUs: () => 1_000, wall: true });
    expect(backwardSteps(frames)).toBe(0);
    for (const f of frames.filter((x) => x.local > 3.4e6 && x.local < 3.9e6)) {
      expect(f.now).toBeLessThanOrEqual(f.newest + 40_000);
    }
  });

  it('the delay follows the inter-arrival distribution', () => {
    // 60 Hz sends; every 10th snapshot arrives 12 ms late (still in order).
    const clock = new TsServerClock(60);
    run(clock, { sends: steady60.sends, latencyUs: (i) => (i % 10 === 0 ? 13_000 : 1_000), wall: false });
    // The p95 gap spans the late arrival (~28.7 ms), well above one tick.
    expect(clock.getInterpolationDelayMs()).toBeGreaterThan(27);
    expect(clock.getInterpolationDelayMs()).toBeLessThan(30);
    expect(clock.getSnapshotIntervalMs()).toBeCloseTo(16.667, 1);
  });

  it('server wall stamps give the sim rate within 5% every second despite jitter', () => {
    // Sim rate steps 1.0 -> 0.4 -> 0.8 each 3 s; arrivals jittered by up to 30 ms.
    const sends: number[] = [];
    let t = 0;
    for (let i = 0; i < 600; i += 1) {
      const hz = [60, 24, 48][Math.floor(t / 3e6) % 3];
      t += 1e6 / hz;
      sends.push(t);
    }
    const clock = new TsServerClock(60);
    const rates: Array<[number, number]> = [];
    const events = sends.map((sent, i) => ({ sent, arrive: sent + 5_000 + ((i * 7919) % 31) * 1_000, server: (i + 1) * TICK_US }))
      .sort((a, b) => a.arrive - b.arrive);
    for (const e of events) {
      clock.observeServerTimeWithWall(e.server, e.sent % 2 ** 32, e.arrive);
      rates.push([e.sent, clock.getRate()]);
    }
    expect(clock.hasWallClock()).toBe(true);
    // One second into each 3 s segment, the rate is within 5% of the truth.
    for (const [segmentStart, hz] of [[3e6, 24], [6e6, 48], [9e6, 60]] as const) {
      const at = rates.filter(([sent]) => sent > segmentStart + 1.5e6 && sent < segmentStart + 3e6);
      const truth = (hz * TICK_US) / 1e6;
      for (const [, rate] of at) expect(Math.abs(rate - truth) / truth).toBeLessThan(0.05);
    }
  });

  it('unwraps the u32 wall clock', () => {
    const base = 2 ** 32 - 500_000;
    const clock = new TsServerClock(60);
    const frames = run(clock, { sends: Array.from({ length: 120 }, (_, i) => base + i * TICK_US), latencyUs: () => 1_000, wall: true });
    expect(clock.getRate()).toBeCloseTo(1, 2);
    expect(backwardSteps(frames)).toBe(0);
  });
});

describe('TsServerClock matches clock_sync.rs (WasmClockSync)', () => {
  initWasmForTests();
  const traces: Array<[string, Trace]> = [
    ['steady 60 Hz', steady60],
    ['35 Hz', slow35],
    ['35 Hz, wall stamps', { ...slow35, wall: true }],
    ['20-60 Hz with stalls', varying],
    ['20-60 Hz with stalls, wall stamps', { ...varying, wall: true }],
  ];
  for (const [name, trace] of traces) {
    it(name, () => {
      const ts = new TsServerClock(60);
      const wasm = new WasmClockSync(60) as unknown as ServerClockModel;
      ts.observeRtt(4);
      wasm.observeRtt(4);
      const a = run(ts, trace);
      const b = run(wasm, trace);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) {
        expect(Math.abs(a[i].now - b[i].now)).toBeLessThan(1e-3);
        expect(Math.abs(a[i].delayUs - b[i].delayUs)).toBeLessThan(1e-3);
      }
      expect(ts.getRate()).toBeCloseTo(wasm.getRate(), 9);
      expect(ts.hasWallClock()).toBe(wasm.hasWallClock());
      wasm.free();
    });
  }
});

describe('RenderClock', () => {
  it('never goes backwards while the delay grows and the server clock is frozen', () => {
    const clock = new RenderClock();
    clock.setTargetDelayMs(20);
    let last = clock.renderTimeUs(1_000_000, 0);
    // The recommended delay jumps to 120 ms while the server is stalled.
    clock.setTargetDelayMs(120);
    for (let t = 1; t < 50; t += 1) {
      const r = clock.renderTimeUs(1_000_000, t * 8_000);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    // Then the server resumes; the delay grows only as the clock advances.
    for (let t = 0; t < 400; t += 1) {
      const r = clock.renderTimeUs(1_000_000 + t * 8_000, 400_000 + t * 8_000);
      expect(r).toBeGreaterThanOrEqual(last);
      expect(r - last).toBeLessThanOrEqual(8_000 * (1 + RenderClock.DELAY_SLEW) + 1e-6);
      last = r;
    }
    expect(clock.delayMs).toBeCloseTo(120, 6);
  });

  it('shrinking the delay moves render time forward at a bounded rate', () => {
    const clock = new RenderClock();
    clock.setTargetDelayMs(200);
    let last = clock.renderTimeUs(1_000_000, 0);
    clock.setTargetDelayMs(20);
    for (let t = 1; t < 200; t += 1) {
      const r = clock.renderTimeUs(1_000_000 + t * 8_000, t * 8_000);
      expect(r - last).toBeLessThanOrEqual(8_000 * (1 + RenderClock.DELAY_SLEW) + 1e-6);
      last = r;
    }
    expect(clock.delayMs).toBeCloseTo(20, 6);
  });

  it('a local clock seeking back starts over', () => {
    const clock = new RenderClock();
    clock.setTargetDelayMs(20);
    clock.renderTimeUs(10_000_000, 10_000_000);
    expect(clock.renderTimeUs(100_000, 0)).toBe(80_000);
  });
});
