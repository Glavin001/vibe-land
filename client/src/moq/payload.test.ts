import { describe, expect, it } from 'vitest';

import {
  ChunkState,
  PayloadDecodeError,
  applyRegionPayload,
  decodeWorldPayload,
  type RegionPayload,
  type WorldChunk,
} from './payload';

function hex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * The exact bytes asserted by `region_golden_vector` in
 * `moq/publisher/src/wire.rs`. If the Rust encoder changes, that test and this
 * one fail together.
 */
const REGION_GOLDEN = hex(`
  01
  02
  04030201
  01efcdab89010000
  02
  0200
  0700 02 80 c0f9 c201 4006 bbf3
  3f00 03 00 0000 0000 0080 ff7f
`);

/** Matching vector for `meta_golden_vector`. */
const META_GOLDEN = hex(`
  01
  03
  09000000
  0100000000000000
  0300
  1100
  2a
  0a
  746f77657220646f776e
`);

describe('decodeWorldPayload', () => {
  it('decodes the region golden vector produced by the Rust publisher', () => {
    const payload = decodeWorldPayload(REGION_GOLDEN) as RegionPayload;

    expect(payload.kind).toBe('delta');
    expect(payload.tick).toBe(0x0102_0304);
    expect(payload.publishedAtMs).toBe(1_690_804_547_329);
    expect(payload.region).toBe(2);
    expect(payload.chunks).toHaveLength(2);

    const [first, second] = payload.chunks;

    expect(first.id).toBe(7);
    expect(first.state).toBe(ChunkState.Falling);
    expect(first.hp).toBe(128);
    expect(first.x).toBe(-16);
    expect(first.y).toBe(4.5);
    expect(first.z).toBe(16);
    expect(first.yaw).toBeCloseTo(-3.141, 6);

    // The extremes of the fixed-point ranges, to catch a signedness mistake.
    expect(second.id).toBe(63);
    expect(second.state).toBe(ChunkState.Rubble);
    expect(second.hp).toBe(0);
    expect(second.z).toBeCloseTo(-327.68, 6);
    expect(second.yaw).toBeCloseTo(32.767, 6);
  });

  it('decodes the meta golden vector produced by the Rust publisher', () => {
    const payload = decodeWorldPayload(META_GOLDEN);

    expect(payload).toEqual({
      kind: 'meta',
      tick: 9,
      publishedAtMs: 1,
      round: 3,
      playersAlive: 17,
      destroyedPct: 42,
      headline: 'tower down',
    });
  });

  it('reads an empty delta as a valid heartbeat', () => {
    // 14-byte header plus region and a zero count: what a quiet region sends.
    const payload = decodeWorldPayload(
      hex('01 02 01000000 0200000000000000 03 0000'),
    ) as RegionPayload;

    expect(payload.region).toBe(3);
    expect(payload.chunks).toEqual([]);
  });

  it('decodes a payload sitting at a non-zero offset in a larger buffer', () => {
    // MoQ object payloads are subarrays of the stream buffer, so byteOffset is
    // routinely non-zero and the DataView has to account for it.
    const backing = new Uint8Array(REGION_GOLDEN.length + 5);
    backing.set(REGION_GOLDEN, 5);

    const payload = decodeWorldPayload(backing.subarray(5)) as RegionPayload;
    expect(payload.chunks).toHaveLength(2);
    expect(payload.chunks[0].id).toBe(7);
  });

  it('rejects payloads it cannot safely read', () => {
    expect(() => decodeWorldPayload(new Uint8Array(4))).toThrow(PayloadDecodeError);

    // Version 2 is not something this decoder knows about.
    const wrongVersion = Uint8Array.from(REGION_GOLDEN);
    wrongVersion[0] = 2;
    expect(() => decodeWorldPayload(wrongVersion)).toThrow(/unsupported payload version 2/);

    // Unknown kind byte.
    const wrongKind = Uint8Array.from(REGION_GOLDEN);
    wrongKind[1] = 9;
    expect(() => decodeWorldPayload(wrongKind)).toThrow(/unknown payload kind 9/);

    // Declares two chunks but only carries one.
    expect(() => decodeWorldPayload(REGION_GOLDEN.subarray(0, REGION_GOLDEN.length - 1))).toThrow(
      /declares 2 chunks/,
    );
  });
});

describe('applyRegionPayload', () => {
  const chunk = (id: number, state: number): WorldChunk => ({
    id,
    state,
    hp: 255,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
  });

  it('patches only the chunks a delta carries', () => {
    const known = new Map([
      [1, chunk(1, ChunkState.Intact)],
      [2, chunk(2, ChunkState.Intact)],
    ]);

    const next = applyRegionPayload(known, {
      kind: 'delta',
      tick: 1,
      publishedAtMs: 0,
      region: 0,
      chunks: [chunk(2, ChunkState.Rubble)],
    });

    expect(next.get(1)?.state).toBe(ChunkState.Intact);
    expect(next.get(2)?.state).toBe(ChunkState.Rubble);
  });

  it('replaces the whole region on a snapshot so stale chunks cannot linger', () => {
    const known = new Map([[1, chunk(1, ChunkState.Rubble)]]);

    const next = applyRegionPayload(known, {
      kind: 'snapshot',
      tick: 2,
      publishedAtMs: 0,
      region: 0,
      chunks: [chunk(5, ChunkState.Intact)],
    });

    expect(next.has(1)).toBe(false);
    expect(next.get(5)?.state).toBe(ChunkState.Intact);
  });

  it('leaves the caller-supplied map untouched', () => {
    const known = new Map([[1, chunk(1, ChunkState.Intact)]]);
    applyRegionPayload(known, {
      kind: 'delta',
      tick: 1,
      publishedAtMs: 0,
      region: 0,
      chunks: [chunk(1, ChunkState.Rubble)],
    });

    expect(known.get(1)?.state).toBe(ChunkState.Intact);
  });
});
