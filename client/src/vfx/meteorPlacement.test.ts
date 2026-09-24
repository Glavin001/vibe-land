import { describe, expect, it } from 'vitest';

import type { DynamicBodySample } from '../net/interpolation';
import {
  meteorFlightForgotten,
  meteorPositionAt,
  meteorVelocityAt,
  newMeteorTrack,
  type MeteorFlight,
} from './meteorFlights';
import { placeMeteor, STALE_AFTER_TICKS } from './meteorPlacement';

const G = 9.81;
const TICK_US = Math.round(1_000_000 / 60);
const LAUNCH_US = 5_000_000;

/** A 147 m/s meteor on a 2.5 s arc onto (12, 0, -40). */
function flight(): MeteorFlight {
  const start: [number, number, number] = [300, 260, -100];
  const target: [number, number, number] = [12, 0, -40];
  const T = 2.5;
  return {
    bodyId: 31,
    shooterPlayerId: 4,
    serverLaunchTimeUs: LAUNCH_US,
    start,
    velocity: [
      (target[0] - start[0]) / T,
      (target[1] - start[1]) / T + 0.5 * G * T,
      (target[2] - start[2]) / T,
    ],
    target,
    radiusM: 2,
    gravityMs2: G,
    flightTimeS: T,
    launchedAtLocalMs: 0,
    seed: 1,
    lastStreamedAtMs: 0,
    track: newMeteorTrack(),
  };
}

/** A server snapshot of the rock at `serverUs`: on the arc (plus `offset`) until it lands. */
function sampleAt(f: MeteorFlight, serverUs: number, offset: [number, number, number] = [0, 0, 0]): DynamicBodySample {
  const t = (serverUs - f.serverLaunchTimeUs) / 1e6;
  const p = meteorPositionAt(f, t, [0, 0, 0]);
  const v = meteorVelocityAt(f, t, [0, 0, 0]);
  return {
    serverTimeUs: serverUs,
    position: [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]],
    quaternion: [0, 0, 0, 1],
    halfExtents: [2, 2, 2],
    velocity: v,
    angularVelocity: [0, 0, 0],
    shapeType: 1,
  };
}

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('placeMeteor', () => {
  it('is hidden before launch and on the arc before any snapshot', () => {
    const f = flight();
    expect(placeMeteor(f, f.track, { renderServerUs: LAUNCH_US - 1000, samples: [], ticksSinceSeen: null, tickUs: TICK_US, nowMs: 0 }).source).toBe('hidden');
    const p = placeMeteor(f, f.track, { renderServerUs: LAUNCH_US + 1e6, samples: [], ticksSinceSeen: null, tickUs: TICK_US, nowMs: 0 });
    expect(p.source).toBe('arc');
    expect(dist(p.position, meteorPositionAt(f, 1, [0, 0, 0]))).toBeLessThan(1e-9);
  });

  it('a single streamed sample far ahead of the render time does not jump the rock', () => {
    // The first body snapshot arrives 160 ms of server time ahead of the render
    // time (the lead that made a 22 m jump at 147 m/s): the rock stays on the arc.
    const f = flight();
    const render = LAUNCH_US + 2_000_000;
    const before = placeMeteor(f, f.track, { renderServerUs: render, samples: [], ticksSinceSeen: null, tickUs: TICK_US, nowMs: 0 });
    const one = [sampleAt(f, render + 160_000, [0.3, -0.2, 0.1])];
    const after = placeMeteor(f, f.track, { renderServerUs: render + 8_333, samples: one, ticksSinceSeen: 0, tickUs: TICK_US, nowMs: 8 });
    expect(after.source).toBe('arc');
    const expected = meteorPositionAt(f, (render + 8_333 - LAUNCH_US) / 1e6, [0, 0, 0]);
    expect(dist(after.position, expected)).toBeLessThan(1e-9);
    // One frame of motion at ~150 m/s, not lead x speed.
    expect(dist(after.position, before.position)).toBeLessThan(1.5);
  });

  it('hands over to the body at contact without a discontinuity', () => {
    const f = flight();
    const samples: DynamicBodySample[] = [];
    let lastPos: number[] | null = null;
    let maxGapToPrevSource = 0;
    let prevSource = '';
    // Snapshots every tick from 2.3 s; contact at 2.45 s (the rock stops 1 m short of the arc and bounces up).
    for (let us = LAUNCH_US + 2_300_000; us <= LAUNCH_US + 2_700_000; us += TICK_US) {
      const t = (us - LAUNCH_US) / 1e6;
      const s = t < 2.45
        ? sampleAt(f, us, [0.2, -0.1, 0])
        : { ...sampleAt(f, LAUNCH_US + 2_450_000), serverTimeUs: us, position: [20, 1 + (t - 2.45) * 5, -43] as [number, number, number], velocity: [30, 5, -10] as [number, number, number] };
      samples.push(s);
      // Render 40 ms behind the newest snapshot, at 120 Hz between snapshots.
      for (const r of [us - 40_000, us - 40_000 + 8_333]) {
        const p = placeMeteor(f, f.track, { renderServerUs: r, samples, ticksSinceSeen: 0, tickUs: TICK_US, nowMs: 0 });
        if (lastPos && prevSource && p.source !== prevSource) {
          // The switch frame: compare with where the previous source was at this render time.
          maxGapToPrevSource = Math.max(maxGapToPrevSource, dist(p.position, p.arc));
        }
        lastPos = p.position;
        prevSource = p.source;
      }
    }
    expect(prevSource).toBe('body');
    expect(maxGapToPrevSource).toBeLessThan(1);
  });

  it('extrapolates a body past its newest snapshot without sinking below it', () => {
    const f = flight();
    f.track.contactUs = LAUNCH_US; // already on the body
    const s1 = { ...sampleAt(f, LAUNCH_US + 2_600_000), position: [20, 2, -43] as [number, number, number], velocity: [10, -8, 0] as [number, number, number] };
    const s2 = { ...s1, serverTimeUs: s1.serverTimeUs + TICK_US, position: [20.16, 1.87, -43] as [number, number, number], velocity: [10, -8.16, 0] as [number, number, number] };
    const p = placeMeteor(f, f.track, { renderServerUs: s2.serverTimeUs + 200_000, samples: [s1, s2], ticksSinceSeen: 0, tickUs: TICK_US, nowMs: 0 });
    expect(p.source).toBe('body');
    expect(p.position[1]).toBeGreaterThanOrEqual(s2.position[1]);
    expect(p.position[0]).toBeGreaterThan(s2.position[0]);
  });

  it('judges staleness in snapshots missed, so a server stall does not hold the rock', () => {
    const f = flight();
    f.track.contactUs = LAUNCH_US;
    const s = [{ ...sampleAt(f, LAUNCH_US + 2_600_000), position: [20, 1, -43] as [number, number, number], velocity: [30, 0, 0] as [number, number, number] }];
    // The server is stalled: no newer snapshot at all, however long it takes.
    expect(placeMeteor(f, f.track, { renderServerUs: s[0].serverTimeUs, samples: s, ticksSinceSeen: 0, tickUs: TICK_US, nowMs: 900 }).source).toBe('body');
    // Newer snapshots arrive without the moving rock: it has left the stream.
    expect(placeMeteor(f, f.track, { renderServerUs: s[0].serverTimeUs, samples: s, ticksSinceSeen: STALE_AFTER_TICKS + 1, tickUs: TICK_US, nowMs: 1000 }).source).toBe('hold');
  });

  it('forgets flights on server time when the render time is known', () => {
    const f = flight();
    // A never-streamed rock lingers 3 s of server time past its flight, however slow the server.
    expect(meteorFlightForgotten(f, 60_000, LAUNCH_US + 5_400_000)).toBe(false);
    expect(meteorFlightForgotten(f, 60_000 - 1, LAUNCH_US + 5_600_000)).toBe(true);
    // A rock drawn from its body is forgotten 0.75 s of server time after it was last drawn.
    f.track.lastBodyUs = LAUNCH_US + 3_000_000;
    expect(meteorFlightForgotten(f, 0, LAUNCH_US + 3_700_000)).toBe(false);
    expect(meteorFlightForgotten(f, 0, LAUNCH_US + 3_800_000)).toBe(true);
  });
});
