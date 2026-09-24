// A tape of everything the server sent, for replaying a session without one.
//
// Rendering performance during destruction cannot be measured on the live
// page: no two impacts are alike, the scene moves under any sweep, and the
// server, netcode and physics all come along. What the renderer actually
// consumes is a byte stream, so that stream is recorded here with arrival
// times, and /cityreplay feeds it back through the real clients under the
// real renderer. Same bytes, same ledger, same frames, every time; a sweep can
// rewind the tape for each configuration and its rows compare like with like.
//
// Version 1 tapes held only the city stream (bootstrap, topology, debris):
// the city and its dust replayed, but nothing else did -- a meteor's damage
// arrived without the meteor, whose body travels in the game snapshots.
// Version 2 records EVERY inbound packet on every channel -- WebTransport
// control stream and datagrams, or the WebSocket -- so the replay routes and
// decodes each one exactly as the transport did: city kinds into the city
// client, the rest (snapshots with players, vehicles and dynamic bodies,
// shot traces, rosters, body metadata) into a netcode client. Recording
// starts mid-session, so the session state those packets need to be read --
// the welcome (the recording player's id, the tick and interpolation
// parameters), the player roster, the dynamic-body metadata that turns a
// snapshot handle into a body -- is re-played from the last copies received,
// as a prelude at t=0. The city side still opens on a resync request, so the
// tape starts from a fresh bootstrap of the city as it is at that moment.
// The manifest is not in the tape -- it is fetched by hash from the page's
// own origin, as the game does.
//
// Format, little-endian throughout:
//   VLTAPE01: magic; u32 header length; JSON header; `frames` frame samples of
//     `frameBytes` each -- [f32 tMs][f32 frameMs][f32 cpuMs][u32 awake]
//     [f32 camera xyz][f32 camera quaternion xyzw] (16 bytes before the camera
//     was added) -- then packets as [u32 tMs][u32 len][bytes], all city.
//   VLTAPE02: the same layout with 60-byte frames, which append the recording
//     client's clock state [f64 clock offset us][f32 interpolation delay ms]
//     [f32 dynamic-body interpolation delay ms], and packets as
//     [f64 tMs][u32 len][u8 channel][bytes], `channel` one of TAPE_CHANNEL_*,
//     with TAPE_CHANNEL_PRELUDE set on the prelude's copies.
// Tapes live in IndexedDB on the reporter's machine and can be downloaded as
// files or uploaded to the server.

import type { InboundChannel } from '../net/inbound';
import { decodeServerReliablePacket } from '../net/protocol';
import {
  PKT_BATTERY_SYNC,
  PKT_DYNAMIC_BODY_META,
  PKT_LOCAL_PLAYER_ENERGY,
  PKT_PING,
  PKT_PLAYER_ROSTER,
  PKT_WELCOME,
} from '../net/sharedConstants';

const MAGIC_V1 = 'VLTAPE01';
const MAGIC_V2 = 'VLTAPE02';
const DB_NAME = 'vibe.city.tapes';
const STORE = 'tapes';

/** v1 tapes: the city stream, transport unrecorded. */
export const TAPE_CHANNEL_CITY = 0;
export const TAPE_CHANNEL_WT_RELIABLE = 1;
export const TAPE_CHANNEL_WT_DATAGRAM = 2;
export const TAPE_CHANNEL_WEBSOCKET = 3;
/** A round-trip sample the server clock was fed (WebSocket pongs): payload f32 ms. */
export const TAPE_CHANNEL_RTT = 4;
/** Set on the prelude: session state received before the recording started. */
export const TAPE_CHANNEL_PRELUDE = 0x80;

const CHANNEL_NAMES: Record<number, string> = {
  [TAPE_CHANNEL_CITY]: 'city',
  [TAPE_CHANNEL_WT_RELIABLE]: 'wt-reliable',
  [TAPE_CHANNEL_WT_DATAGRAM]: 'wt-datagram',
  [TAPE_CHANNEL_WEBSOCKET]: 'websocket',
  [TAPE_CHANNEL_RTT]: 'rtt',
};

export function tapeChannelName(channel: number): string {
  const base = CHANNEL_NAMES[channel & ~TAPE_CHANNEL_PRELUDE] ?? `channel-${channel & ~TAPE_CHANNEL_PRELUDE}`;
  return channel & TAPE_CHANNEL_PRELUDE ? `${base}+prelude` : base;
}

export function tapeChannelOf(channel: InboundChannel): number {
  switch (channel) {
    case 'wt-reliable': return TAPE_CHANNEL_WT_RELIABLE;
    case 'wt-datagram': return TAPE_CHANNEL_WT_DATAGRAM;
    case 'websocket': return TAPE_CHANNEL_WEBSOCKET;
  }
}

/** The transport channel a tape packet arrived on; null for city-only (v1) and RTT records. */
export function inboundChannelOf(tapeChannel: number): InboundChannel | null {
  switch (tapeChannel & ~TAPE_CHANNEL_PRELUDE) {
    case TAPE_CHANNEL_WT_RELIABLE: return 'wt-reliable';
    case TAPE_CHANNEL_WT_DATAGRAM: return 'wt-datagram';
    case TAPE_CHANNEL_WEBSOCKET: return 'websocket';
    default: return null;
  }
}

/** The welcome's session parameters, as the recording client had them. */
export interface CityTapeSession {
  simHz: number;
  snapshotHz: number;
  interpolationDelayMs: number;
  protocolVersion: number;
  physicsBackend: number;
  clientMovementMode: number;
}

export interface CityTapeHeader {
  version: 1 | 2;
  capturedAt: string;
  matchId: string;
  manifestHash: string;
  wireVersion: number;
  simHz: number;
  userAgent: string;
  durationMs: number;
  packets: number;
  bytes: number;
  /** Frame samples in the block after the header, `frameBytes` each (16 before the camera was added). */
  frames?: number;
  frameBytes?: number;
  /** v2: the recording player's id, from the session's welcome. */
  localPlayerId?: number;
  /** v2: 'webtransport' or 'websocket'. */
  transport?: string;
  /** v2: the welcome's parameters; null when the session had not been welcomed. */
  session?: CityTapeSession | null;
  /** v2: packets at t=0 re-playing session state from before the recording started. */
  prelude?: number;
  /** v2: packets and bytes per channel (tapeChannelName). */
  channels?: Record<string, { packets: number; bytes: number }>;
  /**
   * v2: the recording page's `performance.now()` at tape time 0. The frame
   * clock samples' offsets are against that page's clock; add this (as us)
   * to put them on the tape's.
   */
  clockOriginMs?: number;
}

/** One rendered frame on the recording machine: when, and what it cost there. */
export interface CityTapeFrames {
  /** Tape time in ms of each frame. */
  times: Float32Array;
  frameMs: Float32Array;
  cpuMs: Float32Array;
  /** Chunks awake, as the recorder's 2 Hz telemetry last reported it. */
  awake: Uint32Array;
  /** Camera position (xyz) and quaternion (xyzw) per frame; the replay can follow it. */
  camera: Float32Array;
  /**
   * The recording client's server-clock offset (us) and interpolation delays
   * (players, dynamic bodies; ms) at each frame: what the live renderer drew
   * at. Absent on v1 tapes.
   */
  clock: { offsetUs: Float64Array; interpDelayMs: Float32Array; dynDelayMs: Float32Array } | null;
}

const FRAME_BYTES_V1 = 44;
const FRAME_BYTES_V2 = 60;

export interface CityTape {
  header: CityTapeHeader;
  /** Arrival time in ms from recording start, per packet. */
  times: Float64Array;
  packets: Uint8Array[];
  /** TAPE_CHANNEL_* per packet; all TAPE_CHANNEL_CITY on a v1 tape. */
  channels: Uint8Array;
  /**
   * The frames the recording machine drew while the tape ran, so the replay
   * can show WHERE the storm hurt and scrub straight to it. Absent on tapes
   * cut before this existed.
   */
  frames: CityTapeFrames | null;
}

/**
 * Who opened the current recording. The RECORD TAPE button, the automatic
 * hot-spot watch and the e2e bridge share one recorder; each stops only the
 * recording it owns, so a timer from one can never cut another's tape.
 */
export type CityTapeOwner = 'manual' | 'hotspot' | 'e2e';

/** What the live session can tell the recorder about itself. */
export interface CityTapeSessionProbe {
  transport: () => string;
  /** The clock state the renderer is drawing at, sampled every recorded frame. */
  clock: () => { offsetUs: number; interpDelayMs: number; dynDelayMs: number } | null;
}

/**
 * Session-state packets: each one replaces what the previous copy said, so
 * the last copy received is all a tape that starts later needs.
 */
const KEYFRAME_KINDS = [PKT_WELCOME, PKT_PLAYER_ROSTER, PKT_DYNAMIC_BODY_META, PKT_LOCAL_PLAYER_ENERGY];

/** The live recorder; one per page. */
class CityTapeRecorder {
  private startedAtMs = 0;
  private owner: CityTapeOwner | null = null;
  // Increments whenever a recording starts or changes hands; a stale token
  // (a hot-spot timer whose tape the player took over) stops nothing.
  private session = 0;
  private times: number[] = [];
  private packets: Uint8Array[] = [];
  private channels: number[] = [];
  private bytes = 0;
  private preludeCount = 0;
  private frameTimes: number[] = [];
  private frameMs: number[] = [];
  private frameCpuMs: number[] = [];
  private frameAwake: number[] = [];
  private frameCamera: number[] = [];
  private frameClock: number[] = [];
  private lastAwake = 0;
  private meta: { matchId: string; manifestHash: string; wireVersion: number; simHz: number } | null = null;
  private requestResync: (() => void) | null = null;
  private probe: CityTapeSessionProbe | null = null;
  // The session state a recording opened later needs: the last copy of each
  // keyframe kind, and the battery set as a full resync plus its deltas.
  private readonly keyframes = new Map<number, { bytes: Uint8Array; channel: number }>();
  private batteries: Array<{ bytes: Uint8Array; channel: number }> = [];
  private listeners = new Set<() => void>();

  get recording(): boolean {
    return this.startedAtMs > 0;
  }

  /** What the runtime knows once the city client exists; needed by the header. */
  describe(
    meta: { matchId: string; manifestHash: string; wireVersion: number; simHz: number },
    requestResync: () => void,
  ): void {
    this.meta = meta;
    this.requestResync = requestResync;
  }

  /** The live session, for the clock samples and the header; null when it ends. */
  describeSession(probe: CityTapeSessionProbe | null): void {
    this.probe = probe;
    if (!probe) {
      this.keyframes.clear();
      this.batteries = [];
    }
  }

  /** Who owns the recording in progress, if any. */
  get currentOwner(): CityTapeOwner | null {
    return this.recording ? this.owner : null;
  }

  /**
   * Opens a tape for `owner` on a fresh bootstrap and returns its session
   * token, or 0 when another owner's recording is in progress. The player
   * pressing RECORD during an automatic hot-spot recording takes that
   * recording over instead: it keeps what was captured so far (the tape
   * already opens on a bootstrap), and the hot-spot's stop then finds its
   * token stale and leaves the tape alone.
   */
  start(owner: CityTapeOwner): number {
    if (this.recording) {
      if (owner === 'manual' && this.owner === 'hotspot') {
        this.owner = 'manual';
        this.session += 1;
        this.notify();
        return this.session;
      }
      return 0;
    }
    this.owner = owner;
    this.session += 1;
    this.startedAtMs = performance.now();
    this.times = [];
    this.packets = [];
    this.channels = [];
    this.bytes = 0;
    this.frameTimes = [];
    this.frameMs = [];
    this.frameCpuMs = [];
    this.frameAwake = [];
    this.frameCamera = [];
    this.frameClock = [];
    // The prelude: session state from before this moment, at t=0, so every
    // snapshot on the tape can be read (whose handle is which body, which
    // player is the one recording).
    const prelude = [
      ...KEYFRAME_KINDS.map((kind) => this.keyframes.get(kind)).filter((entry) => entry !== undefined),
      ...this.batteries,
    ];
    for (const entry of prelude) this.record(0, entry.channel | TAPE_CHANNEL_PRELUDE, entry.bytes);
    this.preludeCount = prelude.length;
    this.requestResync?.();
    this.notify();
    return this.session;
  }

  /**
   * Every inbound packet, as the transport received it. Kept while recording;
   * the session-state kinds are remembered always, for the next prelude.
   */
  pushRaw(bytes: Uint8Array, channel: InboundChannel): void {
    const kind = bytes[0];
    // WebTransport latency probes are answered by the transport and read by nothing.
    if (channel === 'wt-datagram' && kind === PKT_PING) return;
    const tapeChannel = tapeChannelOf(channel);
    if (KEYFRAME_KINDS.includes(kind)) {
      this.keyframes.set(kind, { bytes: bytes.slice(), channel: tapeChannel });
    } else if (kind === PKT_BATTERY_SYNC) {
      const fullResync = bytes.length > 1 && bytes[1] !== 0;
      if (fullResync) this.batteries = [];
      this.batteries.push({ bytes: bytes.slice(), channel: tapeChannel });
    }
    if (!this.recording) return;
    this.record(performance.now() - this.startedAtMs, tapeChannel, bytes.slice());
  }

  /** A city packet whose transport is not known (the v1 recorder's entry point). */
  push(bytes: Uint8Array): void {
    if (!this.recording) return;
    this.record(performance.now() - this.startedAtMs, TAPE_CHANNEL_CITY, bytes.slice());
  }

  /** A round-trip sample the server clock was fed (WebSocket pongs). */
  noteRtt(rttMs: number): void {
    if (!this.recording) return;
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setFloat32(0, rttMs, true);
    this.record(performance.now() - this.startedAtMs, TAPE_CHANNEL_RTT, payload);
  }

  private record(tMs: number, channel: number, bytes: Uint8Array): void {
    this.times.push(tMs);
    this.packets.push(bytes);
    this.channels.push(channel);
    this.bytes += bytes.length;
  }

  /** Every rendered frame while recording: the governor's frame hook calls this. */
  noteFrame(
    frameMs: number,
    cpuMs: number,
    camera: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } },
  ): void {
    if (!this.recording || !(frameMs > 0)) return;
    this.frameTimes.push(performance.now() - this.startedAtMs);
    this.frameMs.push(frameMs);
    this.frameCpuMs.push(cpuMs);
    this.frameAwake.push(this.lastAwake);
    const { position: p, quaternion: q } = camera;
    this.frameCamera.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w);
    const clock = this.probe?.clock() ?? null;
    this.frameClock.push(clock?.offsetUs ?? NaN, clock?.interpDelayMs ?? NaN, clock?.dynDelayMs ?? NaN);
  }

  /** The city layer's 2 Hz telemetry reports how many chunks are awake. */
  noteAwake(awake: number): void {
    this.lastAwake = awake;
  }

  /**
   * The tape clock -- ms since the recording in progress started -- at local
   * time `atMs` (now by default); null when not recording.
   */
  elapsedMs(atMs = performance.now()): number | null {
    return this.recording ? atMs - this.startedAtMs : null;
  }

  status(): { recording: boolean; owner: CityTapeOwner | null; seconds: number; packets: number; megabytes: number } {
    return {
      recording: this.recording,
      owner: this.currentOwner,
      seconds: this.recording ? (performance.now() - this.startedAtMs) / 1000 : 0,
      packets: this.packets.length,
      megabytes: this.bytes / 1e6,
    };
  }

  /** Closes the recording `session` opened; null if it is not the one in progress. */
  stop(session: number): CityTape | null {
    if (!this.recording || session === 0 || session !== this.session) return null;
    const durationMs = performance.now() - this.startedAtMs;
    const clockOriginMs = this.startedAtMs;
    this.startedAtMs = 0;
    this.owner = null;
    const meta = this.meta ?? { matchId: 'city-default', manifestHash: '', wireVersion: 3, simHz: 60 };
    const welcome = this.keyframes.get(PKT_WELCOME);
    let session_: CityTapeSession | null = null;
    let localPlayerId: number | undefined;
    if (welcome) {
      const packet = decodeServerReliablePacket(welcome.bytes);
      if (packet.type === 'welcome') {
        localPlayerId = packet.playerId;
        session_ = {
          simHz: packet.simHz,
          snapshotHz: packet.snapshotHz,
          interpolationDelayMs: packet.interpolationDelayMs,
          protocolVersion: packet.protocolVersion,
          physicsBackend: packet.physicsBackend,
          clientMovementMode: packet.clientMovementMode,
        };
      }
    }
    const channels = Uint8Array.from(this.channels);
    const tape: CityTape = {
      header: {
        version: 2,
        capturedAt: new Date().toISOString(),
        ...meta,
        userAgent: navigator.userAgent,
        durationMs,
        packets: this.packets.length,
        bytes: this.bytes,
        localPlayerId,
        transport: this.probe?.transport(),
        session: session_,
        prelude: this.preludeCount,
        channels: channelTotals(channels, this.packets),
        clockOriginMs,
      },
      times: Float64Array.from(this.times),
      packets: this.packets,
      channels,
      frames: {
        times: Float32Array.from(this.frameTimes),
        frameMs: Float32Array.from(this.frameMs),
        cpuMs: Float32Array.from(this.frameCpuMs),
        awake: Uint32Array.from(this.frameAwake),
        camera: Float32Array.from(this.frameCamera),
        clock: {
          offsetUs: Float64Array.from(this.frameClock.filter((_, i) => i % 3 === 0)),
          interpDelayMs: Float32Array.from(this.frameClock.filter((_, i) => i % 3 === 1)),
          dynDelayMs: Float32Array.from(this.frameClock.filter((_, i) => i % 3 === 2)),
        },
      },
    };
    this.times = [];
    this.packets = [];
    this.channels = [];
    this.bytes = 0;
    this.frameTimes = [];
    this.frameMs = [];
    this.frameCpuMs = [];
    this.frameAwake = [];
    this.frameCamera = [];
    this.frameClock = [];
    this.notify();
    return tape;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const cityTapeRecorder = new CityTapeRecorder();

function channelTotals(channels: Uint8Array, packets: Uint8Array[]): Record<string, { packets: number; bytes: number }> {
  const totals: Record<string, { packets: number; bytes: number }> = {};
  channels.forEach((channel, index) => {
    const name = tapeChannelName(channel);
    const entry = totals[name] ?? (totals[name] = { packets: 0, bytes: 0 });
    entry.packets += 1;
    entry.bytes += packets[index].length;
  });
  return totals;
}

/**
 * The tape as a file: VLTAPE02, unless it is a v1 tape (city packets only,
 * from a file or IndexedDB), which is written back as it was read.
 */
export function encodeCityTape(tape: CityTape): Uint8Array {
  const v1 = tape.header.version === 1 && tape.channels.every((channel) => channel === TAPE_CHANNEL_CITY);
  const magic = v1 ? MAGIC_V1 : MAGIC_V2;
  const frameBytes = v1 ? FRAME_BYTES_V1 : FRAME_BYTES_V2;
  const packetHeader = v1 ? 8 : 13;
  const frameCount = tape.frames ? tape.frames.times.length : 0;
  const header = new TextEncoder().encode(JSON.stringify({
    ...tape.header,
    version: v1 ? 1 : 2,
    frames: frameCount,
    frameBytes,
  }));
  let size = magic.length + 4 + header.length + frameCount * frameBytes;
  for (const packet of tape.packets) size += packetHeader + packet.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < magic.length; i += 1) out[at++] = magic.charCodeAt(i);
  view.setUint32(at, header.length, true);
  at += 4;
  out.set(header, at);
  at += header.length;
  if (tape.frames) {
    const clock = tape.frames.clock;
    for (let i = 0; i < frameCount; i += 1) {
      view.setFloat32(at, tape.frames.times[i], true);
      view.setFloat32(at + 4, tape.frames.frameMs[i], true);
      view.setFloat32(at + 8, tape.frames.cpuMs[i], true);
      view.setUint32(at + 12, tape.frames.awake[i], true);
      for (let c = 0; c < 7; c += 1) view.setFloat32(at + 16 + c * 4, tape.frames.camera[i * 7 + c] ?? 0, true);
      if (!v1) {
        view.setFloat64(at + 44, clock?.offsetUs[i] ?? NaN, true);
        view.setFloat32(at + 52, clock?.interpDelayMs[i] ?? NaN, true);
        view.setFloat32(at + 56, clock?.dynDelayMs[i] ?? NaN, true);
      }
      at += frameBytes;
    }
  }
  tape.packets.forEach((packet, index) => {
    if (v1) {
      view.setUint32(at, Math.round(tape.times[index]), true);
      view.setUint32(at + 4, packet.length, true);
    } else {
      view.setFloat64(at, tape.times[index], true);
      view.setUint32(at + 8, packet.length, true);
      out[at + 12] = tape.channels[index];
    }
    at += packetHeader;
    out.set(packet, at);
    at += packet.length;
  });
  return out;
}

export function decodeCityTape(bytes: Uint8Array): CityTape {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC_V1.length));
  if (magic !== MAGIC_V1 && magic !== MAGIC_V2) throw new Error(`not a city tape (${magic})`);
  const v1 = magic === MAGIC_V1;
  at = MAGIC_V1.length;
  const headerLength = view.getUint32(at, true);
  at += 4;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + headerLength))) as CityTapeHeader;
  header.version = v1 ? 1 : 2;
  at += headerLength;
  let frames: CityTapeFrames | null = null;
  if (header.frames && header.frames > 0) {
    const n = header.frames;
    const frameBytes = header.frameBytes ?? 16;
    const hasClock = frameBytes >= FRAME_BYTES_V2;
    frames = {
      times: new Float32Array(n),
      frameMs: new Float32Array(n),
      cpuMs: new Float32Array(n),
      awake: new Uint32Array(n),
      camera: new Float32Array(n * 7),
      clock: hasClock
        ? { offsetUs: new Float64Array(n), interpDelayMs: new Float32Array(n), dynDelayMs: new Float32Array(n) }
        : null,
    };
    for (let i = 0; i < n; i += 1) {
      frames.times[i] = view.getFloat32(at, true);
      frames.frameMs[i] = view.getFloat32(at + 4, true);
      frames.cpuMs[i] = view.getFloat32(at + 8, true);
      frames.awake[i] = view.getUint32(at + 12, true);
      if (frameBytes >= FRAME_BYTES_V1) {
        for (let c = 0; c < 7; c += 1) frames.camera[i * 7 + c] = view.getFloat32(at + 16 + c * 4, true);
      } else {
        frames.camera[i * 7 + 6] = 1;
      }
      if (frames.clock) {
        frames.clock.offsetUs[i] = view.getFloat64(at + 44, true);
        frames.clock.interpDelayMs[i] = view.getFloat32(at + 52, true);
        frames.clock.dynDelayMs[i] = view.getFloat32(at + 56, true);
      }
      at += frameBytes;
    }
  }
  const packetHeader = v1 ? 8 : 13;
  const times: number[] = [];
  const packets: Uint8Array[] = [];
  const channels: number[] = [];
  while (at + packetHeader <= bytes.length) {
    const t = v1 ? view.getUint32(at, true) : view.getFloat64(at, true);
    const length = view.getUint32(at + (v1 ? 4 : 8), true);
    const channel = v1 ? TAPE_CHANNEL_CITY : bytes[at + 12];
    at += packetHeader;
    times.push(t);
    packets.push(bytes.slice(at, at + length));
    channels.push(channel);
    at += length;
  }
  return { header, times: Float64Array.from(times), packets, channels: Uint8Array.from(channels), frames };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Stored under `name`, and again under 'last' so /cityreplay finds it with no query. */
export async function saveCityTape(name: string, tape: CityTape): Promise<void> {
  const db = await openDb();
  const bytes = encodeCityTape(tape);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, name);
    tx.objectStore(STORE).put(bytes, 'last');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadCityTape(name = 'last'): Promise<CityTape | null> {
  const db = await openDb();
  const bytes = await new Promise<Uint8Array | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(name);
    request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return bytes ? decodeCityTape(bytes) : null;
}

export async function listCityTapes(): Promise<string[]> {
  const db = await openDb();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.map(String));
    request.onerror = () => reject(request.error);
  });
  db.close();
  return keys.filter((key) => key !== 'last');
}

export function downloadCityTape(tape: CityTape): void {
  const bytes = encodeCityTape(tape);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `city-${tape.header.capturedAt.replace(/[:.]/g, '-')}.vltape`;
  link.click();
  URL.revokeObjectURL(url);
}
