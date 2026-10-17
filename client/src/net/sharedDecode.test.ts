import { describe, expect, it } from 'vitest';
import { initWasmForTests } from '../wasm/testInit';
import {
  decodeServerDatagramPacket,
  decodeServerReliablePacket,
  decodeSnapshotV2Packet,
  provideReliablePacketDecoder,
  provideSnapshotV2Decoder,
  SNAPSHOT_V2_INPUT_QUEUE_TAG,
  SNAPSHOT_V2_REMOVALS_TAG,
} from './protocol';
import {
  PKT_DAMAGE_EVENT,
  PKT_DYNAMIC_BODY_META,
  PKT_LOCAL_PLAYER_ENERGY,
  PKT_PING,
  PKT_PLAYER_ROSTER,
  PKT_PONG,
  PKT_SHOT_FIRED,
  PKT_SHOT_RESULT,
  PKT_SNAPSHOT_V2,
  PKT_WELCOME,
} from './sharedConstants';
import { decodeServerPacketShared, decodeSnapshotV2Shared } from './sharedDecode';

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

/** Random bytes in a reliable packet's layout: `fields` are the byte widths after the kind. */
function reliable(next: () => number, kind: number, fields: number[]): Uint8Array {
  const out = [kind];
  for (const width of fields) for (let i = 0; i < width; i += 1) out.push(Math.floor(next() * 256));
  return Uint8Array.from(out);
}

describe('shared reliable-packet decoder (the Unreal client\'s, via WASM)', () => {
  initWasmForTests();

  // Wire layouts (server/src/protocol.rs encoders), byte widths after the kind byte.
  const shapes: Array<[string, number, () => number[]]> = [
    ['welcome', PKT_WELCOME, () => [4, 2, 1, 1, 2, 2, 8, 2]],
    ['welcome without capabilities', PKT_WELCOME, () => [4, 2, 2, 8, 2]],
    ['shotResult', PKT_SHOT_RESULT, () => [4, 1, 1, 4, 1, 1, 4, 2, 2]],
    ['shotFired', PKT_SHOT_FIRED, () => [4, 4, 1, 1, 1, 8, 4, 4, 4, 4, 4, 4]],
    ['damageEvent', PKT_DAMAGE_EVENT, () => [4, 1, 1, 4, 4, 4, 4]],
    ['localPlayerEnergy', PKT_LOCAL_PLAYER_ENERGY, () => [4]],
    ['serverPing', PKT_PING, () => [4]],
    ['pong', PKT_PONG, () => [4]],
  ];

  it.each(shapes)('%s equals the TypeScript decoder', (_name, kind, fields) => {
    const next = rng(kind * 31 + fields().length);
    for (let i = 0; i < 200; i += 1) {
      const bytes = reliable(next, kind, fields());
      // Server times are u64 µs; keep them under 2^53 as real ones are (both decoders give a JS number).
      if (kind === PKT_WELCOME || kind === PKT_SHOT_FIRED) {
        const at = kind === PKT_WELCOME ? bytes.length - 3 : 1 + 4 + 4 + 3 + 7;
        bytes[at] &= 0x1f;
      }
      expect(decodeServerPacketShared(bytes)).toStrictEqual(decodeServerReliablePacket(bytes));
    }
  });

  it.each([0, 1, 5])('playerRoster with %i entries equals the TypeScript decoder', (count) => {
    const next = rng(100 + count);
    const bytes = reliable(next, PKT_PLAYER_ROSTER, [1, ...Array(count).fill([1, 4]).flat()]);
    bytes[1] = count;
    expect(decodeServerPacketShared(bytes)).toStrictEqual(decodeServerReliablePacket(bytes));
  });

  it.each([0, 1, 4])('dynamicBodyMeta with %i entries equals the TypeScript decoder', (count) => {
    const next = rng(200 + count);
    const bytes = reliable(next, PKT_DYNAMIC_BODY_META, [2, ...Array(count).fill([2, 4, 1, 2, 2, 2]).flat()]);
    bytes[1] = count;
    bytes[2] = 0;
    expect(decodeServerPacketShared(bytes)).toStrictEqual(decodeServerReliablePacket(bytes));
  });

  it('leaves other kinds to the TypeScript decoder, and the hook routes the rest through it', () => {
    const snapshot = packet(rng(5), { self: 33, trailer: true, removals: null, inputQueue: false });
    expect(decodeServerPacketShared(snapshot)).toBeNull();
    const ping = Uint8Array.from([PKT_PING, 1, 2, 3, 4]);
    let calls = 0;
    provideReliablePacketDecoder((b) => { calls += 1; return decodeServerPacketShared(b); });
    try {
      expect(decodeServerReliablePacket(ping)).toStrictEqual({ type: 'serverPing', value: 0x04030201 });
      expect(calls).toBe(1);
    } finally {
      provideReliablePacketDecoder(null);
    }
  });
});
