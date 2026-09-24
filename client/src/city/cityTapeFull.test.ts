// The full-world tape: format (v1 and v2), the recorder on both transports,
// and the replay's netcode client reproducing what the live client saw.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cityTapeRecorder,
  decodeCityTape,
  encodeCityTape,
  TAPE_CHANNEL_CITY,
  TAPE_CHANNEL_PRELUDE,
  TAPE_CHANNEL_RTT,
  TAPE_CHANNEL_WEBSOCKET,
  TAPE_CHANNEL_WT_DATAGRAM,
  TAPE_CHANNEL_WT_RELIABLE,
  type CityTape,
} from './cityTape';
import { ReplayNetWorld } from './replayWorld';
import { createReplayPlayer } from './cityReplay';
import type { LoadedCityManifest } from './manifest';
import { clearMeteorFlights, meteorFlights, METEOR_LAUNCHED_PACKET_LEN } from '../vfx/meteorFlights';
import { NetcodeClient } from '../net/netcodeClient';
import { frameReliablePacket } from '../net/protocol';
import {
  PKT_CITY_CHUNKS,
  PKT_CITY_DEBRIS,
  PKT_DYNAMIC_BODY_META,
  PKT_METEOR_LAUNCHED,
  PKT_PING,
  PKT_PLAYER_ROSTER,
  PKT_SHOT_FIRED,
  PKT_SNAPSHOT,
  PKT_SNAPSHOT_V2,
  PKT_WELCOME,
} from '../net/sharedConstants';

// ── Server packet builders (the server's wire layout) ─────────────────────

function setU64(view: DataView, o: number, value: number): void {
  view.setUint32(o, value % 0x100000000, true);
  view.setUint32(o + 4, Math.floor(value / 0x100000000), true);
}

function welcome(playerId: number, interpolationDelayMs = 100): Uint8Array {
  const out = new Uint8Array(23);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_WELCOME);
  view.setUint32(o, playerId, true); o += 4;
  view.setUint16(o, 3, true); o += 2; // protocol version
  view.setUint8(o++, 1); // physics backend
  view.setUint8(o++, 0); // full prediction
  view.setUint16(o, 60, true); o += 2;
  view.setUint16(o, 60, true); o += 2;
  setU64(view, o, 1_000_000); o += 8;
  view.setUint16(o, interpolationDelayMs, true);
  return out;
}

function roster(entries: Array<[handle: number, playerId: number]>): Uint8Array {
  const out = new Uint8Array(2 + entries.length * 5);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_PLAYER_ROSTER);
  view.setUint8(1, entries.length);
  entries.forEach(([handle, playerId], i) => {
    view.setUint8(2 + i * 5, handle);
    view.setUint32(3 + i * 5, playerId, true);
  });
  return out;
}

function bodyMeta(entries: Array<{ handle: number; bodyId: number; radiusCm: number }>): Uint8Array {
  const out = new Uint8Array(3 + entries.length * 13);
  const view = new DataView(out.buffer);
  view.setUint8(0, PKT_DYNAMIC_BODY_META);
  view.setUint16(1, entries.length, true);
  entries.forEach((entry, i) => {
    const o = 3 + i * 13;
    view.setUint16(o, entry.handle, true);
    view.setUint32(o + 2, entry.bodyId, true);
    view.setUint8(o + 6, 1); // sphere
    view.setUint16(o + 7, entry.radiusCm, true);
    view.setUint16(o + 9, entry.radiusCm, true);
    view.setUint16(o + 11, entry.radiusCm, true);
  });
  return out;
}

/**
 * A v2 snapshot: the local player at `anchorM` plus spheres given in world
 * metres (quantised relative to the anchor, 2.5 mm steps, as the server does).
 */
function snapshotV2(
  tick: number,
  anchorM: [number, number, number],
  spheres: Array<{ handle: number; position: [number, number, number]; velocity: [number, number, number] }>,
): Uint8Array {
  const out = new Uint8Array(1 + 4 + 2 + 12 + 4 + 12 + spheres.length * 20);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_SNAPSHOT_V2);
  view.setUint32(o, tick, true); o += 4;
  view.setUint16(o, 0, true); o += 2;
  const anchorMm = anchorM.map((v) => Math.round(v * 1000));
  for (const v of anchorMm) { view.setInt32(o, v, true); o += 4; }
  view.setUint8(o++, 0); // remote players
  view.setUint8(o++, spheres.length);
  view.setUint8(o++, 0); // boxes
  view.setUint8(o++, 0); // vehicles
  // self state: velocity, yaw, pitch, hp, flags
  for (let i = 0; i < 5; i += 1) { view.setInt16(o, 0, true); o += 2; }
  view.setUint8(o++, 100);
  view.setUint8(o++, 0);
  for (const sphere of spheres) {
    view.setUint16(o, sphere.handle, true); o += 2;
    for (let axis = 0; axis < 3; axis += 1) {
      view.setInt16(o, Math.round((sphere.position[axis] - anchorMm[axis] / 1000) / 0.0025), true); o += 2;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      view.setInt16(o, Math.round(sphere.velocity[axis] * 100), true); o += 2;
    }
    for (let axis = 0; axis < 3; axis += 1) { view.setInt16(o, 0, true); o += 2; }
  }
  return out;
}

/** A v1 snapshot (the WebSocket's mixed stream carries these too) with one player. */
function snapshotV1(tick: number, playerId: number, positionM: [number, number, number]): Uint8Array {
  const out = new Uint8Array(1 + 8 + 4 + 2 + 2 * 5 + 29);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_SNAPSHOT);
  setU64(view, o, tick * Math.round(1_000_000 / 60)); o += 8;
  view.setUint32(o, tick, true); o += 4;
  view.setUint16(o, 0, true); o += 2;
  view.setUint16(o, 1, true); o += 2; // players
  for (let i = 0; i < 4; i += 1) { view.setUint16(o, 0, true); o += 2; }
  view.setUint32(o, playerId, true); o += 4;
  for (const v of positionM) { view.setInt32(o, Math.round(v * 1000), true); o += 4; }
  for (let i = 0; i < 5; i += 1) { view.setInt16(o, 0, true); o += 2; }
  view.setUint8(o++, 100);
  view.setUint16(o, 0, true);
  return out;
}

function shotFired(shooter: number, serverFireTimeUs: number): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4 + 3 + 8 + 24);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_SHOT_FIRED);
  view.setUint32(o, shooter, true); o += 4;
  view.setUint32(o, 9, true); o += 4;
  view.setUint8(o++, 0);
  view.setUint8(o++, 0);
  view.setUint8(o++, 0);
  setU64(view, o, serverFireTimeUs); o += 8;
  for (const v of [0, 1500, 0, 0, 1500, 40_000]) { view.setInt32(o, v, true); o += 4; }
  return out;
}

const cityPacket = (kind: number, n: number) => new Uint8Array([kind, n, n + 1, n + 2]);

function stopAll(): void {
  for (let session = 0; session < 1000 && cityTapeRecorder.recording; session += 1) cityTapeRecorder.stop(session);
}

// ── Format ─────────────────────────────────────────────────────────────────

function sampleTape(version: 1 | 2): CityTape {
  const packets = [cityPacket(122, 1), cityPacket(PKT_CITY_CHUNKS, 2)];
  const channels = version === 1 ? [TAPE_CHANNEL_CITY, TAPE_CHANNEL_CITY] : [TAPE_CHANNEL_WT_RELIABLE, TAPE_CHANNEL_WT_DATAGRAM];
  if (version === 2) {
    packets.unshift(welcome(7));
    channels.unshift(TAPE_CHANNEL_WT_RELIABLE | TAPE_CHANNEL_PRELUDE);
    packets.push(new Uint8Array(new Float32Array([42.5]).buffer));
    channels.push(TAPE_CHANNEL_RTT);
  }
  const times = version === 1 ? [0, 17, 33, 50].slice(0, packets.length) : [0, 16.25, 33.5, 50.125];
  return {
    header: {
      version,
      capturedAt: '2026-09-24T00:00:00.000Z',
      matchId: 'city-default',
      manifestHash: 'ab'.repeat(32),
      wireVersion: 3,
      simHz: 60,
      userAgent: 'test',
      durationMs: 60,
      packets: packets.length,
      bytes: packets.reduce((n, p) => n + p.length, 0),
      ...(version === 2 ? { localPlayerId: 7, transport: 'webtransport', prelude: 1 } : {}),
    },
    times: Float64Array.from(times),
    packets,
    channels: Uint8Array.from(channels),
    frames: {
      times: Float32Array.from([5, 21]),
      frameMs: Float32Array.from([8, 9]),
      cpuMs: Float32Array.from([3, 4]),
      awake: Uint32Array.from([10, 11]),
      camera: Float32Array.from([1, 2, 3, 0, 0, 0, 1, 4, 5, 6, 0, 0, 0, 1]),
      clock: version === 2
        ? {
            offsetUs: Float64Array.from([123_456_789.5, 123_456_790.25]),
            interpDelayMs: Float32Array.from([33, 34]),
            dynDelayMs: Float32Array.from([16, 16]),
          }
        : null,
    },
  };
}

describe('tape format', () => {
  it('round-trips a v2 tape with every channel tag, sub-ms times and clock samples', () => {
    const tape = sampleTape(2);
    const bytes = encodeCityTape(tape);
    // Not VLTAPE02: that is the server's netlab encoder tape.
    expect(String.fromCharCode(...bytes.subarray(0, 8))).toBe('VLCTAPE2');
    const back = decodeCityTape(bytes);
    expect(back.header.version).toBe(2);
    expect(back.header.localPlayerId).toBe(7);
    expect(Array.from(back.times)).toEqual(Array.from(tape.times));
    expect(Array.from(back.channels)).toEqual(Array.from(tape.channels));
    expect(back.packets.map((p) => Array.from(p))).toEqual(tape.packets.map((p) => Array.from(p)));
    expect(Array.from(back.frames!.camera)).toEqual(Array.from(tape.frames!.camera));
    expect(Array.from(back.frames!.clock!.offsetUs)).toEqual(Array.from(tape.frames!.clock!.offsetUs));
    expect(Array.from(back.frames!.clock!.dynDelayMs)).toEqual([16, 16]);
  });

  it('writes a v1 tape back as VLTAPE01 and reads it unchanged', () => {
    const tape = sampleTape(1);
    const bytes = encodeCityTape(tape);
    expect(String.fromCharCode(...bytes.subarray(0, 8))).toBe('VLTAPE01');
    const back = decodeCityTape(bytes);
    expect(back.header.version).toBe(1);
    expect(Array.from(back.channels)).toEqual([TAPE_CHANNEL_CITY, TAPE_CHANNEL_CITY]);
    expect(Array.from(back.times)).toEqual([0, 17]);
    expect(back.frames!.clock).toBeNull();
  });

  it('reads a tape written by the v1 recorder (and a pre-camera one)', () => {
    // Byte for byte what the VLTAPE01 encoder wrote: header JSON, 44-byte
    // frames, then [u32 ms][u32 len][bytes] packets.
    for (const frameBytes of [44, 16]) {
      const header = new TextEncoder().encode(JSON.stringify({
        version: 1, capturedAt: 'x', matchId: 'city-default', manifestHash: 'h', wireVersion: 2, simHz: 60,
        userAgent: 'u', durationMs: 40, packets: 2, bytes: 7, frames: 1, frameBytes,
      }));
      const packets = [new Uint8Array([122, 9, 9]), new Uint8Array([119, 1, 2, 3])];
      const out = new Uint8Array(8 + 4 + header.length + frameBytes + packets.reduce((n, p) => n + 8 + p.length, 0));
      const view = new DataView(out.buffer);
      out.set(new TextEncoder().encode('VLTAPE01'), 0);
      view.setUint32(8, header.length, true);
      out.set(header, 12);
      let at = 12 + header.length;
      view.setFloat32(at, 12.5, true);
      view.setFloat32(at + 4, 8.25, true);
      if (frameBytes === 44) view.setFloat32(at + 16, 7, true); // camera x
      at += frameBytes;
      [[3, packets[0]], [20, packets[1]]].forEach(([t, packet]) => {
        const bytes = packet as Uint8Array;
        view.setUint32(at, t as number, true);
        view.setUint32(at + 4, bytes.length, true);
        out.set(bytes, at + 8);
        at += 8 + bytes.length;
      });
      const tape = decodeCityTape(out);
      expect(tape.header.version).toBe(1);
      expect(Array.from(tape.times)).toEqual([3, 20]);
      expect(Array.from(tape.channels)).toEqual([TAPE_CHANNEL_CITY, TAPE_CHANNEL_CITY]);
      expect(tape.packets.map((p) => Array.from(p))).toEqual(packets.map((p) => Array.from(p)));
      expect(tape.frames!.times[0]).toBe(12.5);
      expect(tape.frames!.camera[0]).toBe(frameBytes === 44 ? 7 : 0);
      expect(tape.frames!.camera[6]).toBe(frameBytes === 44 ? 0 : 1);
    }
  });

  it('refuses a file that is not a tape', () => {
    expect(() => decodeCityTape(new TextEncoder().encode('NOTATAPE1234'))).toThrow(/not a city tape/);
  });

  it('still reads a v2 tape written under the old VLTAPE02 magic', () => {
    const tape = sampleTape(2);
    const bytes = encodeCityTape(tape);
    bytes.set(new TextEncoder().encode('VLTAPE02'), 0);
    const back = decodeCityTape(bytes);
    expect(back.header.version).toBe(2);
    expect(Array.from(back.channels)).toEqual(Array.from(tape.channels));
    expect(back.packets.map((p) => Array.from(p))).toEqual(tape.packets.map((p) => Array.from(p)));
    // Written back under the new magic.
    expect(String.fromCharCode(...encodeCityTape(back).subarray(0, 8))).toBe('VLCTAPE2');
  });

  it('refuses the server\'s netlab encoder tape, which shares the old magic', () => {
    // VLTAPE02, u32 tick rate, 32-byte manifest hash, camera...
    const encoder = new Uint8Array(8 + 4 + 32 + 28);
    encoder.set(new TextEncoder().encode('VLTAPE02'), 0);
    new DataView(encoder.buffer).setUint32(8, 60, true);
    encoder.fill(0xab, 12, 44);
    expect(() => decodeCityTape(encoder)).toThrow(/encoder tape/);
  });

  it('carries the pairing and the wall-clock origin through the file', () => {
    const tape = sampleTape(2);
    tape.header.wallClockOriginMs = 1_790_000_000_123.25;
    tape.header.pairing = {
      sessionId: '20260924-101112-ab12cd',
      state: 'paired',
      serverDir: 'server',
      startTick: 1200,
      stopTick: 4800,
      clockSamples: [{
        what: 'start', sentPerfMs: 10.5, receivedPerfMs: 12.25, serverTick: 1200,
        serverUnixUs: 1_790_000_000_111_000, serverMonoUs: 0,
      }],
    };
    const back = decodeCityTape(encodeCityTape(tape));
    expect(back.header.pairing).toEqual(tape.header.pairing);
    expect(back.header.wallClockOriginMs).toBe(1_790_000_000_123.25);
  });
});

// ── Recorder, through the real transports ──────────────────────────────────

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.OPEN;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(bytes: Uint8Array): void { this.sent.push(bytes); }
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}

/** A WebTransport session whose server side the test writes. */
function fakeWebTransport() {
  let reliable!: ReadableStreamDefaultController<Uint8Array>;
  let datagrams!: ReadableStreamDefaultController<Uint8Array>;
  const sink = () => new WritableStream<Uint8Array>({ write() {} });
  class FakeWT {
    readonly ready = Promise.resolve();
    readonly closed = new Promise<unknown>(() => {});
    readonly datagrams = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => { datagrams = c; } }),
      writable: sink(),
    };
    async createBidirectionalStream() {
      return { readable: new ReadableStream<Uint8Array>({ start: (c) => { reliable = c; } }), writable: sink() };
    }
    close(): void {}
  }
  return {
    FakeWT,
    reliable: (bytes: Uint8Array) => reliable.enqueue(frameReliablePacket(bytes)),
    datagram: (bytes: Uint8Array) => datagrams.enqueue(bytes),
  };
}

const sessionConfig = {
  match_id: 'city-default', url: 'https://127.0.0.1:4102/wt', server_certificate_hash_hex: '',
  sim_hz: 60, snapshot_hz: 60, interpolation_delay_ms: 100, protocol_version: 3, physics_backend: 1,
  client_movement_mode: 0,
};

describe('recorder on the live transports', () => {
  afterEach(() => {
    stopAll();
    cityTapeRecorder.describeSession(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('tags WebTransport reliable and datagram packets, city and game alike, and drops pings', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const wt = fakeWebTransport();
    vi.stubGlobal('window', { WebTransport: wt.FakeWT, location: { search: '', href: 'http://localhost/' } });
    const cityPackets: Uint8Array[] = [];
    const client = new NetcodeClient({
      onRawPacket: (bytes, channel) => cityTapeRecorder.pushRaw(bytes, channel),
      onCityPacket: (bytes) => cityPackets.push(bytes),
    });
    const connected = client.connectWithFallback('city-default', 'ws://unused', undefined, { sessionConfig });
    await vi.waitFor(() => expect(() => wt.reliable(welcome(7))).not.toThrow());
    await connected;
    // Session state that arrives before the recording: the next tape's prelude.
    wt.reliable(roster([[3, 7]]));
    wt.reliable(bodyMeta([{ handle: 1, bodyId: 5001, radiusCm: 20 }]));
    await vi.waitFor(() => expect(client.playerId).toBe(7));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const session = cityTapeRecorder.start('e2e');
    wt.reliable(cityPacket(122, 1));
    wt.datagram(snapshotV2(600, [0, 1, 0], [{ handle: 1, position: [2, 3, 4], velocity: [1, 0, 0] }]));
    wt.datagram(cityPacket(PKT_CITY_DEBRIS, 5));
    wt.datagram(new Uint8Array([PKT_PING, 1, 0, 0, 0]));
    wt.reliable(shotFired(7, 600 * 16_667));
    await vi.waitFor(() => expect(client.dynamicBodies.has(5001)).toBe(true));
    await vi.waitFor(() => expect(cityPackets.length).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tape = cityTapeRecorder.stop(session)!;
    client.disconnect();

    // The prelude: the session state received before the recording, at t=0.
    const P = TAPE_CHANNEL_PRELUDE;
    expect(tape.packets.slice(0, 3).map((p) => p[0])).toEqual([PKT_WELCOME, PKT_PLAYER_ROSTER, PKT_DYNAMIC_BODY_META]);
    expect(Array.from(tape.channels.subarray(0, 3))).toEqual([
      TAPE_CHANNEL_WT_RELIABLE | P, TAPE_CHANNEL_WT_RELIABLE | P, TAPE_CHANNEL_WT_RELIABLE | P,
    ]);
    expect(Array.from(tape.times.subarray(0, 3))).toEqual([0, 0, 0]);
    // Then each channel in its own arrival order (the two streams interleave freely).
    const on = (channel: number) => tape.packets.filter((_, i) => i >= 3 && tape.channels[i] === channel).map((p) => p[0]);
    expect(on(TAPE_CHANNEL_WT_RELIABLE)).toEqual([122, PKT_SHOT_FIRED]);
    expect(on(TAPE_CHANNEL_WT_DATAGRAM)).toEqual([PKT_SNAPSHOT_V2, PKT_CITY_DEBRIS]);
    expect(tape.packets.length).toBe(7);
    expect(tape.header.version).toBe(2);
    expect(tape.header.localPlayerId).toBe(7);
    expect(tape.header.prelude).toBe(3);
    expect(tape.header.session?.interpolationDelayMs).toBe(100);
    const datagramBytes = tape.packets.filter((_, i) => tape.channels[i] === TAPE_CHANNEL_WT_DATAGRAM).reduce((n, p) => n + p.length, 0);
    expect(tape.header.channels?.['wt-datagram']).toEqual({ packets: 2, bytes: datagramBytes });
  });

  it('tags the WebSocket fallback, city and game packets alike, and keeps RTT samples', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // WebSocket is disabled by default; this test is about the (opt-in)
    // WebSocket lane of the tape, so it opts in the one way the client allows.
    vi.stubEnv('VITE_ENABLE_WEBSOCKET', '1');
    const client = new NetcodeClient({
      onRawPacket: (bytes, channel) => cityTapeRecorder.pushRaw(bytes, channel),
      onRttSample: (rttMs) => cityTapeRecorder.noteRtt(rttMs),
    });
    client.connect('ws://localhost/ws');
    const socket = FakeWebSocket.last!;
    socket.deliver(welcome(4));
    const session = cityTapeRecorder.start('manual');
    socket.deliver(snapshotV1(100, 4, [1, 2, 3]));
    socket.deliver(cityPacket(PKT_CITY_CHUNKS, 1));
    // A client ping answered: the round trip feeds the clock and the tape.
    const nonce = client.ping() as unknown;
    void nonce;
    const pong = new Uint8Array(5);
    pong[0] = 111; // PKT_PONG
    new DataView(pong.buffer).setUint32(1, 1, true);
    socket.deliver(pong);
    const tape = cityTapeRecorder.stop(session)!;
    client.disconnect();

    expect(tape.packets.slice(0, 4).map((p) => p[0])).toEqual([PKT_WELCOME, PKT_SNAPSHOT, PKT_CITY_CHUNKS, 111]);
    expect(new DataView(tape.packets[4].buffer).getFloat32(0, true)).toBeGreaterThanOrEqual(0);
    expect(Array.from(tape.channels)).toEqual([
      TAPE_CHANNEL_WEBSOCKET | TAPE_CHANNEL_PRELUDE,
      TAPE_CHANNEL_WEBSOCKET,
      TAPE_CHANNEL_WEBSOCKET,
      TAPE_CHANNEL_WEBSOCKET,
      TAPE_CHANNEL_RTT,
    ]);
    expect(tape.header.localPlayerId).toBe(4);
  });
});

// ── Replay: the netcode client on the tape clock ───────────────────────────

describe('replay world', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reproduces a dynamic body at given replay times from recorded snapshots', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // A ball flying at 12 m/s along x from (10, 5, -3), snapshotted every tick
    // (60 Hz); arrivals 40 ms after the server stamp, with jitter.
    const tickUs = Math.round(1_000_000 / 60);
    const firstTick = 1200;
    const ball = (tick: number): [number, number, number] => [10 + 12 * (tick - firstTick) / 60, 5, -3];
    const packets: Array<{ t: number; bytes: Uint8Array; channel: 'wt-reliable' | 'wt-datagram' }> = [
      { t: 0, bytes: welcome(2, 100), channel: 'wt-reliable' },
      { t: 0, bytes: bodyMeta([{ handle: 4, bodyId: 9001, radiusCm: 30 }]), channel: 'wt-reliable' },
    ];
    const serverToLocalMs = (us: number) => us / 1000 - 19_960; // the arrival clock
    for (let k = 0; k < 60; k += 1) {
      const tick = firstTick + k;
      const jitter = [0, 3, 1, 6, 2][k % 5];
      packets.push({
        t: serverToLocalMs(tick * tickUs) + jitter,
        bytes: snapshotV2(tick, [0, 1, 0], [{ handle: 4, position: ball(tick), velocity: [12, 0, 0] }]),
        channel: 'wt-datagram',
      });
    }
    // Played as the replay plays it: every packet due by the replay time is
    // delivered at its own arrival time, then the frame samples at that time.
    let clock = 0;
    const world = new ReplayNetWorld(() => clock);
    let cursor = 0;
    const playTo = (at: number) => {
      while (cursor < packets.length && packets[cursor].t <= at) {
        clock = packets[cursor].t;
        world.deliver(packets[cursor].bytes, packets[cursor].channel);
        cursor += 1;
      }
      clock = at;
    };
    playTo(100);
    expect(world.playerId).toBe(2);
    expect(world.state.dynamicBodies.has(9001)).toBe(true);

    // Replay times inside the stream: the body is where the snapshots say it
    // was at the render time -- the estimated server time minus the
    // dynamic-body interpolation delay -- to within quantisation and the
    // clock estimate's jitter.
    for (const at of [300, 450, 700]) {
      playTo(at);
      const renderUs = world.getDynamicBodyRenderTimeUs();
      const expectedX = 10 + 12 * (renderUs / tickUs - firstTick) / 60;
      const drawn = world.getRenderedDynamicBodyState(9001)!;
      expect(drawn.position[0]).toBeCloseTo(expectedX, 1);
      expect(drawn.position[1]).toBeCloseTo(5, 2);
      expect(drawn.position[2]).toBeCloseTo(-3, 2);
      // The estimated server clock sits within the arrival jitter of the truth.
      const trueServerUs = (at + 19_960) * 1000;
      expect(Math.abs(renderUs + world.state.dynamicBodyInterpolationDelayMs * 1000 - trueServerUs)).toBeLessThan(8000);
    }

    // A second world fed the same tape reaches the same state: replay is deterministic.
    const at = 700;
    const expected = world.getRenderedDynamicBodyState(9001)!.position;
    let clock2 = 0;
    const again = new ReplayNetWorld(() => clock2);
    for (const packet of packets.filter((p) => p.t <= at)) {
      clock2 = packet.t;
      again.deliver(packet.bytes, packet.channel);
    }
    clock2 = at;
    expect(again.getRenderedDynamicBodyState(9001)!.position).toEqual(expected);
  });

  it('draws the recording player from its own snapshots and everyone\'s shot traces', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let clock = 0;
    const world = new ReplayNetWorld(() => clock);
    world.deliver(welcome(3), 'wt-reliable');
    world.deliver(roster([[1, 3]]), 'wt-reliable');
    const tickUs = Math.round(1_000_000 / 60);
    for (let k = 0; k < 10; k += 1) {
      clock = k * 16.667;
      world.deliver(snapshotV2(500 + k, [4 + k * 0.1, 2, -7], []), 'wt-datagram');
    }
    // The spectated (recording) player is in the drawn set, at its anchor.
    const self = world.players.get(3);
    expect(self).toBeDefined();
    expect(self!.position[0]).toBeCloseTo(4.9, 3);
    const sample = world.samplePlayer(3, world.playerRenderTimeUs());
    expect(sample).not.toBeNull();
    // Its own shot draws a trace (live, it was drawn by local prediction).
    world.deliver(shotFired(3, 509 * tickUs), 'wt-reliable');
    expect(world.shotTraces.length).toBe(1);
    expect(world.shotTraces[0].shooterId).toBe(3);
  });
});

// ── The player: a tape routed the way the transports routed it ────────────

function meteorLaunched(bodyId: number, serverLaunchTimeUs: number): Uint8Array {
  const out = new Uint8Array(METEOR_LAUNCHED_PACKET_LEN);
  const view = new DataView(out.buffer);
  let o = 0;
  view.setUint8(o++, PKT_METEOR_LAUNCHED);
  view.setUint32(o, bodyId, true); o += 4;
  view.setUint32(o, 2, true); o += 4;
  view.setBigUint64(o, BigInt(serverLaunchTimeUs), true); o += 8;
  for (const v of [0, 80, 0, 30, 0, 0, 60, 0, 0, 1.5, 9.81, 2]) { view.setFloat32(o, v, true); o += 4; }
  return out;
}

const tinyManifest = (): LoadedCityManifest => ({
  manifest: {
    version: 1,
    structures: [{
      structureId: 0,
      worldPosition: [0, 0, 0],
      worldRotation: [0, 0, 0, 1],
      chunks: [0, 1].map((node) => ({
        nodeIndex: node, centroid: [0, node + 0.5, 0], mass: node === 0 ? 0 : 10, volume: 1, size: [1, 1, 1],
        geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] }, radius: 0.87, support: node === 0,
      })),
      bonds: [{ bondIndex: 0, node0: 0, node1: 1, centroid: [0, 1, 0], normal: [0, 1, 0], area: 1 }],
    }],
  } as unknown as LoadedCityManifest['manifest'],
  hashHex: 'a'.repeat(64),
  totalChunks: 2,
  totalBonds: 1,
});

describe('replay player', () => {
  afterEach(() => {
    clearMeteorFlights();
    vi.restoreAllMocks();
  });

  it('routes a v2 tape: bodies at their seek times, meteors on the tape clock', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tickUs = Math.round(1_000_000 / 60);
    const firstTick = 3000;
    const offsetMs = firstTick * tickUs / 1000 - 50; // server ms minus tape ms
    const rock = (tick: number): [number, number, number] => [30 * (tick - firstTick) / 60, 60, 0];
    const packets: Uint8Array[] = [welcome(2, 100), bodyMeta([{ handle: 4, bodyId: 777, radiusCm: 150 }])];
    const channels = [TAPE_CHANNEL_WT_RELIABLE | TAPE_CHANNEL_PRELUDE, TAPE_CHANNEL_WT_RELIABLE | TAPE_CHANNEL_PRELUDE];
    const times = [0, 0];
    for (let k = 0; k < 120; k += 1) {
      const tick = firstTick + k;
      times.push((tick * tickUs) / 1000 - offsetMs);
      packets.push(snapshotV2(tick, [0, 1, 0], [{ handle: 4, position: rock(tick), velocity: [30, 0, 0] }]));
      channels.push(TAPE_CHANNEL_WT_DATAGRAM);
      if (k === 6) {
        // The launch, on the city stream (reliable), stamped at tick 3006.
        times.push(times[times.length - 1] + 0.5);
        packets.push(meteorLaunched(777, tick * tickUs));
        channels.push(TAPE_CHANNEL_WT_RELIABLE);
      }
    }
    const tape: CityTape = {
      header: {
        version: 2, capturedAt: 'x', matchId: 'city-default', manifestHash: 'a'.repeat(64), wireVersion: 2,
        simHz: 60, userAgent: 'test', durationMs: times[times.length - 1], packets: packets.length, bytes: 0,
      },
      times: Float64Array.from(times),
      packets,
      channels: Uint8Array.from(channels),
      frames: null,
    };
    const replayed = decodeCityTape(encodeCityTape(tape));
    const assets = { manifest: tinyManifest(), decoder: async () => undefined };
    let player = await createReplayPlayer(replayed, assets);
    expect(player.world).not.toBeNull();
    expect(player.originMs).toBe(0);

    const check = (atMs: number) => {
      player.fastForward(atMs);
      expect(player.tapeTimeMs()).toBe(atMs);
      const world = player.world!;
      const renderUs = world.getDynamicBodyRenderTimeUs();
      const drawn = world.getRenderedDynamicBodyState(777)!;
      expect(drawn.position[0]).toBeCloseTo(30 * (renderUs / tickUs - firstTick) / 60, 1);
      // The render time is the tape time on the server clock, minus the delay.
      expect(renderUs / 1000 + world.state.dynamicBodyInterpolationDelayMs - (atMs + offsetMs)).toBeCloseTo(0, 0);
      // The meteor flight is registered on the tape clock, launched at tick 3006.
      const flight = meteorFlights(atMs).find((f) => f.bodyId === 777)!;
      expect(flight.launchedAtLocalMs).toBeCloseTo(((firstTick + 6) * tickUs) / 1000 - offsetMs, 0);
    };
    check(400);
    check(900);
    // Backwards is a rewind (a fresh player) and a seek forward again.
    player = await player.rewind();
    check(600);
    expect(player.ended()).toBe(false);
  });

  it('plays a v1 (city-only) tape with no world and meteors on their arrival time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tape: CityTape = {
      header: {
        version: 1, capturedAt: 'x', matchId: 'city-default', manifestHash: 'a'.repeat(64), wireVersion: 2,
        simHz: 60, userAgent: 'test', durationMs: 500, packets: 1, bytes: 0,
      },
      times: Float64Array.from([250]),
      packets: [meteorLaunched(55, 123_456_789)],
      channels: Uint8Array.from([TAPE_CHANNEL_CITY]),
      frames: null,
    };
    const player = await createReplayPlayer(decodeCityTape(encodeCityTape(tape)), { manifest: tinyManifest(), decoder: async () => undefined });
    expect(player.world).toBeNull();
    player.fastForward(0);
    expect(meteorFlights(250).find((f) => f.bodyId === 55)?.launchedAtLocalMs).toBe(250);
  });
});
