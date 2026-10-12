// The driven car's input pipeline under the conditions players meet: links
// that are steady, lossy, bursty, duplicating or changing route, latency
// spikes, outages, a stalled tab, a server running behind, clock skew,
// display rates, long drives and sequence wraparound. Each is simulated
// (inputPipeline.ts: the real FixedInputBundler and pacing rule, the server's
// queue rules) under shipping and paced (VIBE_VEHICLE_INPUT_PACING).
//
// What a driver experiences, and the gates (each from the design, not tuned):
// - controls never freeze, and their speed never visibly changes: the input
//   clock stays within +-5% of the server's simulation rate (owner's choice,
//   the Weber fraction for speed);
// - bounded latency: no input waits in the server's queue longer than the
//   target plus the stale margin plus the tick it is applied in (the drop
//   rule: owner's choice);
// - corrections: ticks whose applied controls differ from a perfect
//   pipeline's (`effectivePerMin`), at most the 5% of ticks the target's
//   quantile (0.95) leaves uncovered, and in total over the seeds never more
//   than shipping's, plus the one correction a one-off event may cost (the
//   owner's choice: drop a stale backlog). Counts are small, so steady
//   conditions are driven for 5 minutes a seed;
// - recovery after an event within the round trip, the jitter window (2 s:
//   the target forgets the event's samples; as it falls, a deeper queue is
//   dropped to it) and the pacing time constant (1 s: the clock closes the
//   stale margin the drop leaves). A stalled tab counts too: the client skips
//   the stalled input time (its catch-up cap), a step in lateness the window
//   holds for 2 s.
import { describe, expect, it } from 'vitest';
import { PACED, PACED_FIRST, SHIPPING, frames, lowerBoundSlope, jitterTarget, simulatePipeline, stalled, type FrameModel, type LinkModel } from './inputPipeline';
import { INPUT_PACE_CLOSE_SEC, INPUT_PACE_MAX_DEVIATION } from '../../src/runtime/inputPacing';

const TICK_MS = 1000 / 60;
const STALE_MARGIN = 3; // server/src/vehicle_input_pacing.rs STALE_MARGIN_INPUTS
const JITTER_WINDOW_MS = 120 * TICK_MS;
const QUANTILE = 0.95;
// The live courses press keys for 250 ms and release for 120 (vehicle-measure.mjs).
const CONTROL_CHANGE_MS = 370;
const SEEDS = [1, 2, 3];
const AT = 20_000; // events start 20 s in

// netemProfiles.json
const LTE: LinkModel = { delayMs: 90, jitterMs: 35, loss: 0.03 };
const WIFI_GOOD: LinkModel = { delayMs: 25, jitterMs: 8, loss: 0.005 };
const LOSS_BURST: LinkModel = { delayMs: 30, jitterMs: 5, loss: 0, burst: { p: 1, r: 20 } };
const vsync60 = () => frames(16.667, 0.5);

interface Scenario {
  up: LinkModel;
  down?: LinkModel;
  frames?: () => FrameModel;
  seconds?: number;
  serverTickMs?: (tick: number) => number;
  clientClockRate?: number;
}
const roundTripMs = (s: Scenario) => 2 * (s.up.delayMs + s.up.jitterMs);
const withEvent = (link: LinkModel, ev: LinkModel['events'] extends (infer E)[] | undefined ? E : never): LinkModel => ({ ...link, events: [ev] });

function drive(s: Scenario, policy: typeof PACED, seed: number) {
  return simulatePipeline({
    seconds: s.seconds ?? 60, seed, frames: (s.frames ?? vsync60)(), uplink: s.up, downlink: s.down ?? s.up, ...policy,
    serverTickMs: s.serverTickMs, clientClockRate: s.clientClockRate, controlChangeMeanMs: CONTROL_CHANGE_MS, trace: true,
  });
}
type Drive = ReturnType<typeof drive>;

/** Server ticks after `fromMs` up to and including `toMs`. */
function ticksBetween(res: Drive, fromMs: number, toMs: number): number {
  const t = res.ticksTrace!;
  const first = (ms: number) => { let lo = 0, hi = t.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid].atMs <= ms) lo = mid + 1; else hi = mid; } return lo; };
  return first(toMs) - first(fromMs);
}

/** The invariants every paced drive keeps, whatever the conditions. */
function expectPlayerInvariants(res: Drive) {
  for (const f of res.framesTrace!) {
    // Never frozen, never visibly fast or slow against the world.
    expect(f.rate).toBeGreaterThan(0);
    expect(f.rate / f.simRate).toBeGreaterThanOrEqual(1 - INPUT_PACE_MAX_DEVIATION - 1e-9);
    expect(f.rate / f.simRate).toBeLessThanOrEqual(1 + INPUT_PACE_MAX_DEVIATION + 1e-9);
  }
  for (const t of res.ticksTrace!) {
    if (t.target !== null) expect(t.depth).toBeLessThanOrEqual(t.target + STALE_MARGIN);
  }
  // Queueing, in server ticks from first arrival to application: at most
  // the queue it can wait behind (target + margin) and the tick it is
  // applied in. Against the largest target reported.
  const maxTarget = Math.max(0, ...res.ticksTrace!.map((t) => t.target ?? 0));
  let worstWait = 0;
  for (const x of res.inputs!) {
    if (x.appliedMs === null || x.arrivedMs === null) continue;
    worstWait = Math.max(worstWait, ticksBetween(res, x.arrivedMs, x.appliedMs));
  }
  expect(worstWait).toBeLessThanOrEqual(maxTarget + STALE_MARGIN + 1);
}

/** Effective corrections over the seeds: at most the quantile's 5% of ticks,
 * and no more than shipping's plus one a seed for each one-off event. */
function expectCorrections(paced: Drive[], shipping: Drive[], events = 0) {
  const total = (ds: Drive[]) => ds.reduce((a, d) => a + d.effectivePerMin * (d.ticks / 3600), 0);
  for (const d of paced) expect(d.effectivePerMin).toBeLessThanOrEqual((1 - QUANTILE) * 3600);
  expect(total(paced)).toBeLessThanOrEqual(total(shipping) + events * paced.length);
}

/** When a drive has recovered from an event ending at `endMs`. */
const recovered = (s: Scenario, endMs: number) => endMs + roundTripMs(s) + JITTER_WINDOW_MS + INPUT_PACE_CLOSE_SEC * 1000;

/** Inputs made from `fromMs` on are applied as before the event: their
 * delay's p95 within a tick of it (arrival phase), and their worst within
 * the stale margin and a tick of the worst before. */
function expectRecoveredBy(res: Drive, fromMs: number) {
  const delay = (x: { madeMs: number; appliedMs: number | null }) => (x.appliedMs! - x.madeMs) / TICK_MS;
  const before = res.inputs!.filter((x) => x.appliedMs !== null && x.madeMs > 10_000 && x.madeMs < AT).map(delay);
  const after = res.inputs!.filter((x) => x.appliedMs !== null && x.madeMs >= fromMs && x.madeMs < (res.ticks - 120) * TICK_MS).map(delay);
  expect(after.length).toBeGreaterThan(0);
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(0.95 * xs.length)];
  expect(p95(after)).toBeLessThanOrEqual(p95(before) + 1);
  expect(Math.max(...after)).toBeLessThanOrEqual(Math.max(...before) + STALE_MARGIN + 1);
  // And none of them is lost: only inputs from the event are dropped.
  const lostAfter = res.inputs!.filter((x) => x.appliedMs === null && x.madeMs >= fromMs && x.madeMs < (res.ticks - 120) * TICK_MS);
  expect(lostAfter).toEqual([]);
}

const steady: Record<string, Scenario> = {
  'LTE': { up: LTE },
  'good Wi-Fi': { up: WIFI_GOOD },
  'burst loss (Gilbert-Elliott)': { up: LOSS_BURST },
  'duplicating Wi-Fi': { up: { delayMs: 40, jitterMs: 20, loss: 0.02, duplicate: 0.05 } },
  'client clock 0.5% fast': { up: LTE, clientClockRate: 1.005 },
  'client clock 0.5% slow': { up: LTE, clientClockRate: 0.995 },
  '144 Hz display': { up: LTE, frames: () => frames(6.944, 0.3) },
  '30 Hz display': { up: LTE, frames: () => frames(33.33, 2) },
  '60 Hz with hitches': { up: LTE, frames: () => frames(16.667, 1, 0.02, 80) },
};

describe('vehicle input pipeline: steady conditions', () => {
  for (const [name, s] of Object.entries(steady)) {
    it(name, () => {
      const long = { ...s, seconds: 300 };
      const paced = SEEDS.map((seed) => drive(long, PACED, seed));
      paced.forEach(expectPlayerInvariants);
      expectCorrections(paced, SEEDS.map((seed) => drive(long, SHIPPING, seed)));
    });
  }
});

describe('vehicle input pipeline: events', () => {
  it('a 2 s outage (a tunnel): one correction, then normal latency', () => {
    const s: Scenario = { up: withEvent(LTE, { fromMs: AT, toMs: AT + 2000, loss: 1 }) };
    const paced = SEEDS.map((seed) => drive(s, PACED, seed));
    paced.forEach(expectPlayerInvariants);
    expectCorrections(paced, SEEDS.map((seed) => drive(s, SHIPPING, seed)), 1);
    for (const d of paced) expectRecoveredBy(d, recovered(s, AT + 2000));
  });

  it('a 5 s outage', () => {
    const s: Scenario = { up: withEvent(LTE, { fromMs: AT, toMs: AT + 5000, loss: 1 }) };
    for (const seed of SEEDS) {
      const paced = drive(s, PACED, seed);
      expectPlayerInvariants(paced);
      expectRecoveredBy(paced, recovered(s, AT + 5000));
    }
  });

  it('a 3 s latency spike to 300 ms (a cell handover)', () => {
    const s: Scenario = { up: withEvent(LTE, { fromMs: AT, toMs: AT + 3000, delayMs: 300, jitterMs: 60 }) };
    const paced = SEEDS.map((seed) => drive(s, PACED, seed));
    paced.forEach(expectPlayerInvariants);
    expectCorrections(paced, SEEDS.map((seed) => drive(s, SHIPPING, seed)), 1);
    for (const d of paced) expectRecoveredBy(d, recovered(s, AT + 3000));
  });

  it('a route change, 40 ms to 150 ms and back', () => {
    for (const [from, to] of [[40, 150], [150, 40]]) {
      const link: LinkModel = { delayMs: from, jitterMs: 10, loss: 0.01, events: [{ fromMs: AT, toMs: 1e9, delayMs: to }] };
      const paced = SEEDS.map((seed) => drive({ up: link }, PACED, seed));
      paced.forEach(expectPlayerInvariants);
      expectCorrections(paced, SEEDS.map((seed) => drive({ up: link }, SHIPPING, seed)), 1);
    }
  });

  it('a 3 s stalled tab (alt-tab, background, a long GC)', () => {
    const s: Scenario = { up: LTE, frames: () => stalled(vsync60(), AT, 3000) };
    const paced = SEEDS.map((seed) => drive(s, PACED, seed));
    // Unbounded, the clock stopped for 0.6 s and ran at 3.9x after this.
    paced.forEach(expectPlayerInvariants);
    expectCorrections(paced, SEEDS.map((seed) => drive(s, SHIPPING, seed)), 1);
    for (const d of paced) expectRecoveredBy(d, recovered(s, AT + 3000));
  });

  it('a server running at 30 Hz for 10 s (a city collapse): the car follows the world', () => {
    const s: Scenario = { up: LTE, serverTickMs: (t) => (t >= 1200 && t < 1500 ? 2 * TICK_MS : TICK_MS) };
    const all = SEEDS.map((seed) => drive(s, PACED, seed));
    all.forEach(expectPlayerInvariants);
    expectCorrections(all, SEEDS.map((seed) => drive(s, SHIPPING, seed)), 1);
    for (const paced of all) {
      // Once the client has measured it (a round trip and the 1 s rate
      // window), its input clock runs at half speed, within the 5% bound.
      const slow = paced.framesTrace!.filter((f) => f.atMs > AT + roundTripMs(s) + 1000 && f.atMs < AT + 10_000);
      for (const f of slow) {
        expect(f.rate).toBeGreaterThanOrEqual(0.5 * (1 - INPUT_PACE_MAX_DEVIATION) - 0.02);
        expect(f.rate).toBeLessThanOrEqual(0.5 * (1 + INPUT_PACE_MAX_DEVIATION) + 0.02);
      }
    }
  });
});

describe('vehicle input pipeline: long drives', () => {
  it('holds its queue over ten minutes (no drift, no runaway)', () => {
    const paced = drive({ up: LTE, seconds: 600 }, PACED, 1);
    expectPlayerInvariants(paced);
    const minute = (m: number) => paced.depthBySecond.slice(m * 60, m * 60 + 60).reduce((a, b) => a + b, 0) / 60;
    // The last minute's mean depth is the second minute's, within a tick.
    expect(Math.abs(minute(9) - minute(1))).toBeLessThanOrEqual(1);
  });

  it('crosses the 16-bit sequence wrap (65,536 inputs, 18 min) without a hitch', () => {
    const paced = drive({ up: WIFI_GOOD, seconds: 19 * 60 }, PACED, 1);
    expectPlayerInvariants(paced);
    // Every tick around the wrap applies the next input: none lost, none repeated.
    const around = paced.ticksTrace!.filter((t) => t.atMs > 18 * 60_000 - 5000 && t.atMs < 18 * 60_000 + 15_000);
    const lost = paced.inputs!.filter((x) => x.appliedMs === null && x.madeMs > 18 * 60_000 - 5000 && x.madeMs < 18 * 60_000 + 15_000);
    expect(lost).toEqual([]);
    expect(around.filter((t) => t.starved).length).toBeLessThanOrEqual((1 - QUANTILE) * around.length);
  });
});

describe('vehicle input pipeline: the gates catch what they exist for', () => {
  // Paced as committed before this suite (commit b0b3e846) froze the
  // driver's controls after an outage, ran them at 3.9x after a stalled tab
  // and let its queue grow to two seconds. These gates must fail it.
  it('the first paced version fails the outage', () => {
    const s: Scenario = { up: withEvent(LTE, { fromMs: AT, toMs: AT + 2000, loss: 1 }) };
    expect(() => expectPlayerInvariants(drive(s, PACED_FIRST, 1))).toThrow();
  });
  it('the first paced version fails the stalled tab', () => {
    const s: Scenario = { up: LTE, frames: () => stalled(vsync60(), AT, 3000) };
    expect(() => expectPlayerInvariants(drive(s, PACED_FIRST, 1))).toThrow();
  });
});

describe('the jitter target mirrors the server (server/src/vehicle_input_pacing.rs)', () => {
  // The same cases as the server's tests.
  it('a client pacing its clock is not jitter', () => {
    const drift = (rate: number) => Array.from({ length: 120 }, (_, i) => [i, 100 + Math.floor(i / rate)] as [number, number]);
    expect(jitterTarget(drift(1.05), QUANTILE, 120)).toBeLessThanOrEqual(1);
    expect(jitterTarget(drift(0.95), QUANTILE, 120)).toBeLessThanOrEqual(1);
  });
  it('late arrivals cannot tilt the clock-rate fit', () => {
    const points = Array.from({ length: 120 }, (_, i) => [i, 1000 + i + (i < 5 ? 100 - 20 * i : 0)] as [number, number]);
    expect(lowerBoundSlope(points)).toBeCloseTo(1, 6);
    expect(jitterTarget(points, QUANTILE, 120)).toBeLessThanOrEqual(1);
    // Least squares does tilt: the reason for the lower bound.
    expect(jitterTarget(points, QUANTILE, 120, 'lsq')).toBeGreaterThan(1);
  });
});
