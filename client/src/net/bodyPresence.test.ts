import { describe, expect, it } from 'vitest';
import {
  BodyStreamPresence,
  COLD_REFRESH_TICKS,
  MAX_UNSEEN_TICKS,
  MOVING_BODY_STALE_TICKS,
} from './bodyPresence';

/** Snapshots every tick from `from` to `to` (inclusive) without body 1, except `lost` ticks. */
function run(p: BodyStreamPresence, from: number, to: number, lost: Set<number> = new Set()): number | null {
  for (let tick = from; tick <= to; tick += 1) {
    if (lost.has(tick)) continue;
    if (p.endSnapshot(tick, 1).includes(1)) return tick;
  }
  return null;
}

describe('BodyStreamPresence', () => {
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
