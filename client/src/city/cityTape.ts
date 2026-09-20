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
// Format (VLTAPE01): a JSON header, then packets as [u32 tMs][u32 len][bytes],
// little-endian. Tapes live in IndexedDB on the reporter's machine and can be
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
}

export interface CityTape {
  header: CityTapeHeader;
  /** Arrival time in ms from recording start, per packet. */
  times: Float64Array;
  packets: Uint8Array[];
}

/** The live recorder; one per page. */
class CityTapeRecorder {
  private startedAtMs = 0;
  private times: number[] = [];
  private packets: Uint8Array[] = [];
  private bytes = 0;
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

  /** Opens the tape and asks the server for a fresh bootstrap to open it on. */
  start(): void {
    if (this.recording) return;
    this.startedAtMs = performance.now();
    this.times = [];
    this.packets = [];
    this.bytes = 0;
    this.requestResync?.();
    this.notify();
  }

  /** Every inbound city packet passes through here; a copy is kept while recording. */
  push(bytes: Uint8Array): void {
    if (!this.recording) return;
    this.times.push(performance.now() - this.startedAtMs);
    this.packets.push(bytes.slice());
    this.bytes += bytes.length;
  }

  status(): { recording: boolean; seconds: number; packets: number; megabytes: number } {
    return {
      recording: this.recording,
      seconds: this.recording ? (performance.now() - this.startedAtMs) / 1000 : 0,
      packets: this.packets.length,
      megabytes: this.bytes / 1e6,
    };
  }

  stop(): CityTape | null {
    if (!this.recording) return null;
    const durationMs = performance.now() - this.startedAtMs;
    this.startedAtMs = 0;
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
    };
    this.times = [];
    this.packets = [];
    this.bytes = 0;
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
  const header = new TextEncoder().encode(JSON.stringify(tape.header));
  let size = MAGIC.length + 4 + header.length;
  for (const packet of tape.packets) size += 8 + packet.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (let i = 0; i < MAGIC.length; i += 1) out[at++] = MAGIC.charCodeAt(i);
  view.setUint32(at, header.length, true);
  at += 4;
  out.set(header, at);
  at += header.length;
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
  return { header, times: Float64Array.from(times), packets };
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
