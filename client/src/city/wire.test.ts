// Golden-vector and structural tests for the city wire decoder. The hex
// vectors are pinned from the Rust encoder tests in
// vibe-land/destruction/src/wire.rs — if these change, both sides changed.

import { describe, expect, it } from 'vitest';

import {
  RecordMode,
  decodeChunksDatagram,
  decodeQuat32,
  decodeTopologyHashes,
  encodeCityResyncRequest,
  isCityPacketKind,
} from './wire';

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

// Rust: wire::tests::chunks_datagram_golden_vector
const GOLDEN_CHUNKS =
  '770201000000020003000000010000000081808080080000000000006400c8002c0103000000';

describe('city wire decoder', () => {
  it('decodes the pinned chunks golden vector', () => {
    const datagram = decodeChunksDatagram(fromHex(GOLDEN_CHUNKS));
    expect(datagram.sequence).toBe(1);
    expect(datagram.baselineId).toBe(2);
    expect(datagram.simTick).toBe(3);
    expect(datagram.records).toHaveLength(1);
    const record = datagram.records[0];
    // ids::body_entity(0, 1) = 0x8000_0001
    expect(record.bodyEntity).toBe(0x80000001);
    expect(record.mode).toBe(RecordMode.Absolute);
    expect(record.flags).toBe(0);
    expect(record.position[0]).toBeCloseTo(1.0, 2);
    expect(record.position[1]).toBeCloseTo(2.0, 2);
    expect(record.position[2]).toBeCloseTo(3.0, 2);
    // Identity quat32 = 0x00000003 (largest = w, all components zero).
    expect(record.rotation[3]).toBeCloseTo(1.0, 5);
  });

  it('decodes quat32 identity and axis rotations', () => {
    const identity = decodeQuat32(3);
    expect(identity[3]).toBeCloseTo(1, 6);
    // 90° about Y: q = (0, sin45, 0, cos45); largest index may be y or w.
    // Round-trip property is validated Rust-side; here we sanity-check the
    // scale factor via a known packing: largest=3(w), y = sin45 * 511*sqrt2.
    const scaled = Math.round(Math.SQRT1_2 * 511 * Math.SQRT2) & 0x3ff;
    const packed = 3 + scaled * 2 ** 12; // y occupies the second 10-bit slot
    const q = decodeQuat32(packed);
    expect(q[1]).toBeGreaterThan(0.69);
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 5);
  });

  it('encodes resync requests', () => {
    const bytes = encodeCityResyncRequest(0x01020304);
    expect(Array.from(bytes)).toEqual([9, 0x04, 0x03, 0x02, 0x01]);
  });

  it('encodes a targeted resync request with its structure list', () => {
    const bytes = encodeCityResyncRequest(7, [3, 1]);
    // The 5-byte prefix is byte-identical to the legacy packet, which is what
    // lets an old server treat it as a full-resync request.
    expect(Array.from(bytes)).toEqual([
      9, 7, 0, 0, 0, 2, 3, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it('decodes topology hashes against the pinned server encoding', () => {
    // encode_topology_hashes(5, [(0, 0xb97e54fee243a378)]) in wire.rs — the
    // Rust test pins the same bytes.
    const bytes = new Uint8Array([
      128, 5, 0, 0, 0, 1, 0, 0, 0, 0, 0x78, 0xa3, 0x43, 0xe2, 0xfe, 0x54, 0x7e, 0xb9,
    ]);
    const message = decodeTopologyHashes(bytes);
    expect(message.topoSeq).toBe(5);
    expect(message.hashes).toEqual([
      { structureId: 0, laneA: 0xb97e54fe, laneB: 0xe243a378 },
    ]);
  });

  it('classifies city packet kinds', () => {
    expect(isCityPacketKind(119)).toBe(true);
    expect(isCityPacketKind(122)).toBe(true);
    expect(isCityPacketKind(112)).toBe(false);
    expect(isCityPacketKind(128)).toBe(true);
    expect(isCityPacketKind(129)).toBe(true);
  });
});
