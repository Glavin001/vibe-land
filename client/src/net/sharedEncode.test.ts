import { afterEach, describe, expect, it } from 'vitest';
import { initWasmForTests } from '../wasm/testInit';
import {
  encodeCityCameraDrop,
  encodeClientHello,
  encodeFirePacket,
  encodeInputBundle,
  encodeMeleePacket,
  encodePingPacket,
  encodeVehicleEnterPacket,
  encodeVehicleExitPacket,
  provideSharedEncoders,
} from './protocol';
import { sharedEncoders } from './sharedEncode';

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

const TAU = Math.PI * 2;
/** Values where JavaScript and Rust conversions part: halves, negative halves, out of range, NaN, infinities. */
const EDGES = [0, -0, 0.5, -0.5, 2.5, -2.5, 1, -1, 1.5, -1.5, 127.5, -127.5, 200, -200, 65535.5, 65536, -1,
  2 ** 31, -(2 ** 31) - 1, 2 ** 32 + 7, 2 ** 53, NaN, Infinity, -Infinity];
const ANGLE_EDGES = [0, TAU, -TAU, Math.PI, -Math.PI, 1e9, -1e9, 1e-300, -1e-300, ...Array.from({ length: 8 }, (_, k) => ((k * 8191 + 0.5) / 65535) * TAU), NaN, Infinity];
const SNORM_EDGES = [0, 1, -1, 1.5, -1.5, ...Array.from({ length: 8 }, (_, k) => (k * 4096 + 0.5) / 32767), ...Array.from({ length: 8 }, (_, k) => -(k * 4096 + 0.5) / 32767), NaN];

function pick(next: () => number, edges: number[], random: () => number): number {
  return next() < 0.4 ? edges[Math.floor(next() * edges.length)] : random();
}

/** Each packet encoded by protocol.ts's own encoders and by the shared ones. */
function both<T>(encode: () => T): [T, T] {
  provideSharedEncoders(null);
  const ts = encode();
  provideSharedEncoders(sharedEncoders);
  const shared = encode();
  provideSharedEncoders(null);
  return [ts, shared];
}

describe('shared client-packet encoders (the Unreal client\'s, via WASM)', () => {
  initWasmForTests();
  afterEach(() => provideSharedEncoders(null));
  const next = rng(1);
  const any = () => pick(next, EDGES, () => (next() - 0.5) * 2 ** 20);
  const angle = () => pick(next, ANGLE_EDGES, () => (next() - 0.5) * 40);
  const unit = () => pick(next, SNORM_EDGES, () => next() * 2 - 1);
  const time = () => pick(next, [0, -5, NaN, 2 ** 53, 2 ** 32 - 0.5, 2 ** 32], () => Math.floor(next() * 2 ** 50) + next());

  it('input bundles give the same bytes', () => {
    for (let i = 0; i < 500; i += 1) {
      const frames = Array.from({ length: 1 + Math.floor(next() * 8) }, () => ({
        seq: any(), buttons: any(), moveX: any(), moveY: any(), yaw: angle(), pitch: angle(),
      }));
      const [ts, shared] = both(() => encodeInputBundle(frames));
      expect(shared).toStrictEqual(ts);
    }
  });

  it('input bundles refuse empty and oversized bundles alike', () => {
    provideSharedEncoders(sharedEncoders);
    expect(() => encodeInputBundle([])).toThrow('input bundle cannot be empty');
    const frame = { seq: 1, buttons: 0, moveX: 0, moveY: 0, yaw: 0, pitch: 0 };
    expect(() => encodeInputBundle(Array(256).fill(frame))).toThrow('input bundle too large');
    expect(encodeInputBundle(Array(255).fill(frame)).length).toBe(2 + 255 * 10);
  });

  it('fire, melee, camera drops, vehicles and pings give the same bytes', () => {
    for (let i = 0; i < 500; i += 1) {
      const fire = { seq: any(), shotId: any(), weapon: any(), clientFireTimeUs: time(), clientInterpMs: any(), clientDynamicInterpMs: any(), dir: [unit(), unit(), unit()] as [number, number, number] };
      const melee = { seq: any(), swingId: any(), clientTimeUs: time(), yaw: angle(), pitch: angle() };
      const drop = { position: [any(), any(), any()] as [number, number, number], yaw: angle(), pitch: angle() };
      const [id, seat, nonce] = [any(), any(), any()];
      for (const encode of [
        () => encodeFirePacket(fire),
        () => encodeMeleePacket(melee),
        () => encodeCityCameraDrop(drop),
        () => encodeVehicleEnterPacket(id, seat),
        () => encodeVehicleExitPacket(id),
        () => encodePingPacket(nonce),
      ]) {
        const [ts, shared] = both(encode);
        expect(shared).toStrictEqual(ts);
      }
    }
  });

  it('hellos give the same bytes', () => {
    for (const hello of [
      { matchId: 'citypp-demo' },
      { matchId: '', protocolVersion: 2, movementCapabilities: 1 },
      { matchId: 'città-ü', protocolVersion: 70000, movementCapabilities: 300 },
    ]) {
      const [ts, shared] = both(() => encodeClientHello(hello));
      expect(shared).toStrictEqual(ts);
    }
  });
});
