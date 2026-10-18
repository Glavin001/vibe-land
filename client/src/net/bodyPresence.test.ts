import { describe, expect, it } from 'vitest';
import {
  BodyStreamPresence,
  COLD_REFRESH_TICKS,
  leftInterest,
  MAX_UNSEEN_TICKS,
  MOVING_BODY_STALE_TICKS,
} from './bodyPresence';
import { DYNAMIC_BODY_AOI_EXIT_RADIUS_M } from './sharedConstants';

/** Snapshots every tick from `from` to `to` (inclusive) without body 1, except `lost` ticks. */
function run(p: BodyStreamPresence, from: number, to: number, lost: Set<number> = new Set()): number | null {
  for (let tick = from; tick <= to; tick += 1) {
    if (lost.has(tick)) continue;
    if (p.endSnapshot(tick, 1).includes(1)) return tick;
  }
  return null;
}

describe('BodyStreamPresence', () => {
  // The two worst body render errors of the 2026-09-24 quick 3-client bench
  // (spectator c1: 1.75 m and 0.74 m) were cannonballs leaving the 80 m
  // interest radius, drawn extrapolated for 7-9 ticks past their last
  // snapshot, through a bounce, until the stale window ran out.
  it('a moving body carried past the interest radius is out of the stream at the first snapshot without it', () => {
    const p = new BodyStreamPresence();
    const recipient: [number, number, number] = [0, 1, 0];
    // 79.4 m out, moving away at 60 m/s (1 m a tick).
    p.seen(1, 100, 60, [79.4, 1, 0], [60, 0, 0]);
    expect(p.endSnapshot(100, 1, recipient)).toEqual([]);
    expect(p.endSnapshot(101, 1, recipient)).toEqual([1]);
    expect(p.lastSeenTick(1)).toBeUndefined();
  });

  it('a moving body missing well inside the radius still waits out the stale window', () => {
    const p = new BodyStreamPresence();
    const recipient: [number, number, number] = [0, 1, 0];
    // Budget-starved, not gone: 40 m out, moving towards the recipient.
    p.seen(1, 100, 30, [40, 1, 0], [-30, 0, 0]);
    p.endSnapshot(100, 1, recipient);
    let gone: number | null = null;
    for (let tick = 101; tick <= 200 && gone === null; tick += 1) {
      if (p.endSnapshot(tick, 1, recipient).includes(1)) gone = tick;
    }
    expect(gone).toBe(100 + MOVING_BODY_STALE_TICKS + 1);
  });

  it('leaves a body alone when the recipient or its motion is unknown', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 60);
    p.endSnapshot(100, 1, [0, 0, 0]);
    expect(p.endSnapshot(101, 1, [0, 0, 0])).toEqual([]);
    const q = new BodyStreamPresence();
    q.seen(1, 100, 60, [79.4, 1, 0], [60, 0, 0]);
    q.endSnapshot(100, 1);
    expect(q.endSnapshot(101, 1)).toEqual([]);
  });

  it('judges the exit as the snapshot builder does, in three dimensions at the exit radius', () => {
    // 79.5 m out along y: one tick at 60 m/s is 80.5 m, at 24 m/s 79.9 m.
    expect(leftInterest({ position: [0, 79.5, 0], velocity: [0, 60, 0] }, 1, [0, 0, 0])).toBe(true);
    expect(leftInterest({ position: [0, 79.5, 0], velocity: [0, 24, 0] }, 1, [0, 0, 0])).toBe(false);
    expect(leftInterest({ position: [0, 79.5, 0], velocity: [0, 24, 0] }, 2, [0, 0, 0])).toBe(true);
    // Sideways past the radius: the distance is three-dimensional.
    expect(leftInterest({ position: [60, 52.8, 3], velocity: [0, 0, 60] }, 1, [0, 0, 0])).toBe(true);
    expect(DYNAMIC_BODY_AOI_EXIT_RADIUS_M).toBe(80);
  });

  it('a moving body is out of the stream after the stale window', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 30);
    expect(p.endSnapshot(100, 1)).toEqual([]);
    expect(run(p, 101, 400)).toBe(100 + MOVING_BODY_STALE_TICKS + 1);
    expect(p.lastSeenTick(1)).toBeUndefined();
  });

  it('a resting body stays until its refresh is due, and goes when the refresh snapshot comes without it', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 0);
    p.endSnapshot(100, 1);
    expect(run(p, 101, 400)).toBe(100 + COLD_REFRESH_TICKS);
  });

  it('a lost snapshot in the refresh window defers the verdict to the next refresh', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 0);
    p.endSnapshot(100, 1);
    // The refresh at 160 may have been in the lost snapshot.
    expect(run(p, 101, 400, new Set([160]))).toBe(100 + 2 * COLD_REFRESH_TICKS);
  });

  it('snapshots lost right after the last sighting move the refresh later', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 0);
    p.endSnapshot(100, 1);
    // 101-104 lost: the server may have sent it last at 104, refreshing at 164.
    expect(run(p, 101, 400, new Set([101, 102, 103, 104]))).toBe(164);
  });

  it('seeing the body again resets it', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 30);
    p.endSnapshot(100, 1);
    expect(run(p, 101, 110)).toBeNull();
    p.seen(1, 111, 0);
    p.endSnapshot(111, 1);
    expect(run(p, 112, 400)).toBe(111 + COLD_REFRESH_TICKS);
  });

  it('no body outlives the old 240-tick bound, however many snapshots are lost', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 0);
    p.endSnapshot(100, 1);
    const everyOther = new Set(Array.from({ length: 400 }, (_, i) => 101 + 2 * i));
    const gone = run(p, 101, 600, everyOther);
    expect(gone).not.toBeNull();
    expect(gone! - 100).toBeLessThanOrEqual(MAX_UNSEEN_TICKS + 2);
  });

  it('a slower snapshot rate is not mistaken for loss', () => {
    const p = new BodyStreamPresence();
    p.seen(1, 100, 0);
    p.endSnapshot(100, 2);
    let gone: number | null = null;
    for (let tick = 102; tick <= 400 && gone === null; tick += 2) {
      if (p.endSnapshot(tick, 2).includes(1)) gone = tick;
    }
    expect(gone).toBe(100 + COLD_REFRESH_TICKS);
  });
});
