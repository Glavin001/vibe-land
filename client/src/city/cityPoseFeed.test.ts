import { describe, expect, it } from 'vitest';

import { CityPoseFeed, type FeedPose } from './cityPoseFeed';

type Body = { entity: number; position: [number, number, number]; rotation?: [number, number, number, number] };

/** Frames packed as server/src/pose_feed.rs packs them. */
function pack(frames: Array<{ tick: number; topoSeq: number; bodies: Body[] }>): ArrayBuffer {
  const words: number[] = [];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const bits = (value: number) => {
    f32[0] = value;
    return u32[0];
  };
  for (const frame of frames) {
    words.push(frame.tick, frame.topoSeq, frame.bodies.length);
    for (const body of frame.bodies) {
      words.push(body.entity);
      for (const v of body.position) words.push(bits(v));
      for (const v of body.rotation ?? [0, 0, 0, 1]) words.push(bits(v));
      for (let i = 0; i < 3; i += 1) words.push(bits(0));
    }
  }
  return new Uint32Array(words).buffer;
}

const pose = (): FeedPose => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], linearVelocity: [0, 0, 0] });
const KEY = 0x8000_0000 + 3 * 0x10_0000 + 7;

describe('CityPoseFeed', () => {
  it('draws the newest tick exactly as simulated', () => {
    const queue = [pack([
      { tick: 10, topoSeq: 4, bodies: [{ entity: KEY, position: [1, 2, 3] }] },
      { tick: 11, topoSeq: 4, bodies: [{ entity: KEY, position: [1.123456, 2, 3], rotation: [0, 0.6, 0, 0.8] }] },
    ])];
    const feed = new CityPoseFeed({ poses: () => queue.shift() ?? new ArrayBuffer(0) });
    feed.poll();
    expect(feed.latestTick()).toBe(11);
    const frame = feed.newestAt(4)!;
    expect(frame.tick).toBe(11);
    const out = pose();
    expect(feed.sample(frame, KEY, out)).toBe(true);
    expect(out.position[0]).toBe(Math.fround(1.123456));
    expect(out.rotation).toEqual([0, Math.fround(0.6), 0, Math.fround(0.8)]);
  });

  it('never draws a pose from the other side of a fracture the client has not applied', () => {
    const queue = [pack([
      { tick: 10, topoSeq: 4, bodies: [{ entity: KEY, position: [1, 2, 3] }] },
      { tick: 11, topoSeq: 5, bodies: [{ entity: KEY, position: [9, 2, 3] }] },
    ])];
    const feed = new CityPoseFeed({ poses: () => queue.shift() ?? new ArrayBuffer(0) });
    feed.poll();
    // Tick 11's topology is still in the packet pump: draw tick 10.
    expect(feed.newestAt(4)!.tick).toBe(10);
    expect(feed.newestAt(5)!.tick).toBe(11);
    // A client ahead of every frame (cannot happen in order) draws none.
    expect(feed.newestAt(6)).toBeUndefined();
  });

  it('reads only new frames, and holds only the bodies awake on the server', () => {
    const asked: number[] = [];
    const queue = [
      pack([{ tick: 20, topoSeq: 1, bodies: [{ entity: KEY, position: [0, 0, 0] }] }]),
      pack([{ tick: 21, topoSeq: 1, bodies: [] }]),
    ];
    const feed = new CityPoseFeed({
      poses: (since) => {
        asked.push(since);
        return queue.shift() ?? new ArrayBuffer(0);
      },
    });
    feed.poll();
    feed.poll();
    expect(asked).toEqual([0, 20]);
    const frame = feed.newestAt(1)!;
    expect(frame.tick).toBe(21);
    expect([...feed.entities(frame)]).toEqual([]);
    expect(feed.sample(frame, KEY, pose())).toBe(false);
  });
});
