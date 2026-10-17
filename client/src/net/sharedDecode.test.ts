import { describe, expect, it } from 'vitest';
import { initWasmForTests } from '../wasm/testInit';
import {
  decodeServerDatagramPacket,
  decodeSnapshotV2Packet,
  provideSnapshotV2Decoder,
  SNAPSHOT_V2_INPUT_QUEUE_TAG,
  SNAPSHOT_V2_REMOVALS_TAG,
} from './protocol';
import { PKT_SNAPSHOT_V2 } from './sharedConstants';
import { decodeSnapshotV2Shared } from './sharedDecode';

/** A small deterministic generator (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Variant = { self: 12 | 27 | 33; trailer: boolean; removals: number | null; inputQueue: boolean };

/**
 * A SnapshotV2 packet in one of the shapes the server sends (server/src/protocol.rs
 * encode_snapshot_v2): the self state at 33, 27 or 12 bytes; then the optional wall-clock trailer,
 * removals section (only with the full self state) and input-queue section.
 */
function packet(next: () => number, v: Variant): Uint8Array {
  const out: number[] = [];
  const u8 = (x: number) => out.push(x & 0xff);
  const u16 = (x: number) => { u8(x); u8(x >>> 8); };
  const u32 = (x: number) => { u16(x); u16(x >>> 16); };
  const r8 = () => u8(Math.floor(next() * 256));
  const r16 = () => u16(Math.floor(next() * 65536));
  const r32 = () => u32(Math.floor(next() * 4294967296));
  const count = () => Math.floor(next() * 5);
  u8(PKT_SNAPSHOT_V2);
  r32(); r16(); r32(); r32(); r32();
  const [players, spheres, boxes, vehicles] = [count(), count(), count(), count()];
  u8(players); u8(spheres); u8(boxes); u8(vehicles);
  for (let i = 0; i < 5; i += 1) r16();
  r8(); r8();
  if (v.self >= 27) { r16(); for (let i = 0; i < 6; i += 1) r16(); r8(); }
  if (v.self === 33) for (let i = 0; i < 3; i += 1) r16();
  for (let i = 0; i < players; i += 1) { r8(); for (let k = 0; k < 8; k += 1) r16(); r8(); r8(); }
  for (let i = 0; i < spheres; i += 1) for (let k = 0; k < 10; k += 1) r16();
  for (let i = 0; i < boxes; i += 1) for (let k = 0; k < 14; k += 1) r16();
  for (let i = 0; i < vehicles; i += 1) { r8(); r8(); r8(); r8(); for (let k = 0; k < 13; k += 1) r16(); }
  if (v.trailer) {
    r32();
    if (v.removals !== null) {
      u8(SNAPSHOT_V2_REMOVALS_TAG); u8(v.removals);
      for (let i = 0; i < v.removals; i += 1) { r16(); r8(); }
    }
    if (v.inputQueue) { u8(SNAPSHOT_V2_INPUT_QUEUE_TAG); r8(); r8(); }
  }
  return Uint8Array.from(out);
}

function typescript(bytes: Uint8Array) {
  return decodeSnapshotV2Packet(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 1);
}

describe('shared SnapshotV2 decoder (the Unreal client\'s, via WASM)', () => {
  initWasmForTests();

  const variants: Variant[] = [];
  for (const self of [12, 27, 33] as const) {
    for (const trailer of [false, true]) {
      for (const removals of self === 33 ? [null, 0, 3] : [null]) {
        for (const inputQueue of [false, true]) variants.push({ self, trailer, removals, inputQueue });
      }
    }
  }

  it.each(variants)('equals the TypeScript decoder: %o', (variant) => {
    const next = rng(variants.indexOf(variant) + 1);
    for (let i = 0; i < 200; i += 1) {
      const bytes = packet(next, variant);
      expect(decodeSnapshotV2Shared(bytes)).toStrictEqual(typescript(bytes));
    }
  });

  it('reads packets inside a larger buffer (a datagram view)', () => {
    const bytes = packet(rng(99), { self: 33, trailer: true, removals: 2, inputQueue: true });
    const framed = new Uint8Array(bytes.length + 7);
    framed.set(bytes, 3);
    const view = framed.subarray(3, 3 + bytes.length);
    expect(decodeSnapshotV2Shared(view)).toStrictEqual(typescript(view));
  });

  it('decodes datagrams with it once provided (the flag), and with the TypeScript one otherwise', () => {
    const bytes = packet(rng(7), { self: 33, trailer: true, removals: 1, inputQueue: false });
    let calls = 0;
    provideSnapshotV2Decoder((b) => { calls += 1; return decodeSnapshotV2Shared(b); });
    try {
      expect(decodeServerDatagramPacket(bytes)).toStrictEqual(typescript(bytes));
      expect(calls).toBe(1);
    } finally {
      provideSnapshotV2Decoder(null);
    }
    decodeServerDatagramPacket(bytes);
    expect(calls).toBe(1);
  });
});
