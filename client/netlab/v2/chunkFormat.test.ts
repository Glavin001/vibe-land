import { describe, expect, it } from 'vitest';

import { CityPoseStore } from '../../src/city/cityPoseStore';
import { CHUNK_ENTRY_BYTES, CHUNK_FRAME_HEADER_BYTES, encodeChunkFrame, encodeChunkHeader } from './chunkFormat';

/** Reads one frame back (the Rust reader's layout, chunks.rs). */
function decode(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const sampleMs = view.getFloat64(o, true); o += 8;
  const simTick = view.getUint32(o, true); o += 4;
  const renderTick = view.getFloat32(o, true); o += 4;
  const delay = view.getFloat32(o, true); o += 4;
  const bodies: Array<{ index: number; key: number; pose: number[] }> = [];
  for (let n = view.getUint32(o, true), i = (o += 4, 0); i < n; i += 1) {
    const index = view.getUint32(o, true);
    const key = view.getUint32(o + 4, true);
    const pose = Array.from({ length: 7 }, (_, k) => view.getFloat32(o + 8 + k * 4, true));
    bodies.push({ index, key, pose });
    o += CHUNK_ENTRY_BYTES;
  }
  const records: Array<{ slot: number; index: number; local: number[] }> = [];
  for (let n = view.getUint32(o, true), i = (o += 4, 0); i < n; i += 1) {
    const slot = view.getUint32(o, true);
    const index = view.getInt32(o + 4, true);
    const local = Array.from({ length: 7 }, (_, k) => view.getFloat32(o + 8 + k * 4, true));
    records.push({ slot, index, local });
    o += CHUNK_ENTRY_BYTES;
  }
  return { sampleMs, simTick, renderTick, delay, bodies, records, end: o };
}

describe('VLCHNK01', () => {
  it('writes the header and a frame in the layout the scorer reads, with exact keys', () => {
    const header = encodeChunkHeader({ chunkCount: 2 });
    expect(String.fromCharCode(...header.subarray(0, 8))).toBe('VLCHNK01');
    const store = new CityPoseStore(2, [0, 0]);
    store.trackChanges();
    const key = 0x8000_0000 + 3 * 0x10_0000 + 7;
    const index = store.bodyIndexFor(key);
    store.writeBody(index, [1, 2, 3], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeChunk(1, index, [0.5, 0, -0.5], [0, 0, 0, 1], 0);
    const frame = encodeChunkFrame(1234.5, 99, 101.5, 6, store, store.drainChanges(), new Map(), new Map());
    const d = decode(frame);
    expect(d.end).toBe(frame.length);
    expect(frame.length).toBe(CHUNK_FRAME_HEADER_BYTES + 8 + 2 * CHUNK_ENTRY_BYTES);
    expect([d.sampleMs, d.simTick, d.renderTick, d.delay]).toEqual([1234.5, 99, 101.5, 6]);
    expect(d.bodies).toEqual([{ index, key, pose: [1, 2, 3, 0, 0, 0, 1] }]);
    expect(d.records).toEqual([{ slot: 1, index, local: [0.5, 0, -0.5, 0, 0, 0, 1] }]);
  });

  it('lists only what changed since the last frame, and applies the negative-control shift', () => {
    const store = new CityPoseStore(1, [0]);
    store.trackChanges();
    const bodies = new Map<number, Float64Array>();
    const slots = new Map<number, Float64Array>();
    const i = store.bodyIndexFor(0x8000_0001);
    store.writeBody(i, [1, 1, 1], [0, 0, 0, 1], 1, 1, 1, 1);
    store.writeChunk(0, i, [0, 0, 0], [0, 0, 0, 1], 0);
    decode(encodeChunkFrame(0, 0, 0, 0, store, store.drainChanges(), bodies, slots));
    // Rewritten with the same values: nothing to list.
    store.writeBody(i, [1, 1, 1], [0, 0, 0, 1], 1, 1, 1, 1);
    const same = decode(encodeChunkFrame(1, 0, 0, 0, store, store.drainChanges(), bodies, slots));
    expect([same.bodies.length, same.records.length]).toEqual([0, 0]);
    store.writeBody(i, [2, 1, 1], [0, 0, 0, 1], 1, 1, 1, 1);
    const moved = decode(encodeChunkFrame(2, 0, 0, 0, store, store.drainChanges(), bodies, slots, () => 0.5));
    expect(moved.bodies[0].pose[0]).toBeCloseTo(2.5);
  });
});
