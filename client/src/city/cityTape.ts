// A tape of the city's inbound stream, for replaying a storm without a server.
//
// Rendering performance during destruction cannot be measured on the live
// page: no two impacts are alike, the scene moves under any sweep, and the
// server, netcode and physics all come along. What the renderer actually
// consumes is a byte stream -- a bootstrap, topology batches, pose datagrams
// -- so that stream is recorded here with arrival times, and /cityreplay
// feeds it back into the real CityClient under the real renderer. Same bytes,
// same ledger, same frames, every time; a sweep can rewind the tape for each
// configuration and its rows finally compare like with like.
//
// Recording starts with a resync request so the tape opens on a fresh
// bootstrap of whatever the city looks like at that moment; replay starts
// from that bootstrap. The manifest is not in the tape -- it is fetched by
// hash from the page's own origin, as the game does.
//
// Format (VLTAPE01): a JSON header; then, when the header names `frames`, that
// many frame samples of `frameBytes` each -- [f32 tMs][f32 frameMs][f32 cpuMs]
// [u32 awake][f32 camera xyz][f32 camera quaternion xyzw] -- then packets
// as [u32 tMs][u32 len][bytes]. Little-endian throughout. Tapes live in IndexedDB on the reporter's machine and can be
// downloaded as files.

const MAGIC = 'VLTAPE01';
const DB_NAME = 'vibe.city.tapes';
const STORE = 'tapes';

export interface CityTapeHeader {
  version: 1;
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
}

const FRAME_BYTES = 44;

export interface CityTape {
  header: CityTapeHeader;
  /** Arrival time in ms from recording start, per packet. */
  times: Float64Array;
  packets: Uint8Array[];
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

/** The live recorder; one per page. */
class CityTapeRecorder {
  private startedAtMs = 0;
  private owner: CityTapeOwner | null = null;
  // Increments whenever a recording starts or changes hands; a stale token
  // (a hot-spot timer whose tape the player took over) stops nothing.
  private session = 0;
  private times: number[] = [];
  private packets: Uint8Array[] = [];
  private bytes = 0;
  private frameTimes: number[] = [];
  private frameMs: number[] = [];
  private frameCpuMs: number[] = [];
  private frameAwake: number[] = [];
  private frameCamera: number[] = [];
  private lastAwake = 0;
  private meta: { matchId: string; manifestHash: string; wireVersion: number; simHz: number } | null = null;
  private requestResync: (() => void) | null = null;
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
    this.bytes = 0;
    this.frameTimes = [];
    this.frameMs = [];
    this.frameCpuMs = [];
    this.frameAwake = [];
    this.frameCamera = [];
    this.requestResync?.();
    this.notify();
    return this.session;
  }

  /** Every inbound city packet passes through here; a copy is kept while recording. */
  push(bytes: Uint8Array): void {
    if (!this.recording) return;
    this.times.push(performance.now() - this.startedAtMs);
    this.packets.push(bytes.slice());
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
  }

  /** The city layer's 2 Hz telemetry reports how many chunks are awake. */
  noteAwake(awake: number): void {
    this.lastAwake = awake;
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
    this.startedAtMs = 0;
    this.owner = null;
    const meta = this.meta ?? { matchId: 'city-default', manifestHash: '', wireVersion: 3, simHz: 60 };
    const tape: CityTape = {
      header: {
        version: 1,
        capturedAt: new Date().toISOString(),
        ...meta,
        userAgent: navigator.userAgent,
        durationMs,
        packets: this.packets.length,
        bytes: this.bytes,
      },
      times: Float64Array.from(this.times),
      packets: this.packets,
      frames: {
        times: Float32Array.from(this.frameTimes),
        frameMs: Float32Array.from(this.frameMs),
        cpuMs: Float32Array.from(this.frameCpuMs),
        awake: Uint32Array.from(this.frameAwake),
        camera: Float32Array.from(this.frameCamera),
      },
    };
    this.times = [];
    this.packets = [];
    this.bytes = 0;
    this.frameTimes = [];
    this.frameMs = [];
    this.frameCpuMs = [];
    this.frameAwake = [];
    this.frameCamera = [];
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

export function encodeCityTape(tape: CityTape): Uint8Array {
  const frameCount = tape.frames ? tape.frames.times.length : 0;
  const header = new TextEncoder().encode(JSON.stringify({ ...tape.header, frames: frameCount, frameBytes: FRAME_BYTES }));
  let size = MAGIC.length + 4 + header.length + frameCount * FRAME_BYTES;
  for (const packet of tape.packets) size += 8 + packet.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < MAGIC.length; i += 1) out[at++] = MAGIC.charCodeAt(i);
  view.setUint32(at, header.length, true);
  at += 4;
  out.set(header, at);
  at += header.length;
  if (tape.frames) {
    for (let i = 0; i < frameCount; i += 1) {
      view.setFloat32(at, tape.frames.times[i], true);
      view.setFloat32(at + 4, tape.frames.frameMs[i], true);
      view.setFloat32(at + 8, tape.frames.cpuMs[i], true);
      view.setUint32(at + 12, tape.frames.awake[i], true);
      for (let c = 0; c < 7; c += 1) view.setFloat32(at + 16 + c * 4, tape.frames.camera[i * 7 + c] ?? 0, true);
      at += FRAME_BYTES;
    }
  }
  tape.packets.forEach((packet, index) => {
    view.setUint32(at, Math.round(tape.times[index]), true);
    view.setUint32(at + 4, packet.length, true);
    at += 8;
    out.set(packet, at);
    at += packet.length;
  });
  return out;
}

export function decodeCityTape(bytes: Uint8Array): CityTape {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error(`not a city tape (${magic})`);
  at = MAGIC.length;
  const headerLength = view.getUint32(at, true);
  at += 4;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + headerLength))) as CityTapeHeader;
  at += headerLength;
  let frames: CityTapeFrames | null = null;
  if (header.frames && header.frames > 0) {
    const n = header.frames;
    const frameBytes = header.frameBytes ?? 16;
    frames = { times: new Float32Array(n), frameMs: new Float32Array(n), cpuMs: new Float32Array(n), awake: new Uint32Array(n), camera: new Float32Array(n * 7) };
    for (let i = 0; i < n; i += 1) {
      frames.times[i] = view.getFloat32(at, true);
      frames.frameMs[i] = view.getFloat32(at + 4, true);
      frames.cpuMs[i] = view.getFloat32(at + 8, true);
      frames.awake[i] = view.getUint32(at + 12, true);
      if (frameBytes >= 44) {
        for (let c = 0; c < 7; c += 1) frames.camera[i * 7 + c] = view.getFloat32(at + 16 + c * 4, true);
      } else {
        frames.camera[i * 7 + 6] = 1;
      }
      at += frameBytes;
    }
  }
  const times: number[] = [];
  const packets: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const t = view.getUint32(at, true);
    const length = view.getUint32(at + 4, true);
    at += 8;
    times.push(t);
    packets.push(bytes.slice(at, at + length));
    at += length;
  }
  return { header, times: Float64Array.from(times), packets, frames };
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
