import { PKT_AUDIO_CONTACTS } from '../net/sharedConstants';

export const AUDIO_CONTACT_RECORD_BYTES = 52;
export const AUDIO_CONTACT_MAX_RECORDS = 16;
const MAX_PENDING = 128;
const MAX_RECENT_ENTITIES = 512;
const EXPIRY_MS = 300;
export interface AudioContact {
  simTick: number;
  entityA: number;
  entityB: number;
  position: [number, number, number];
  normal: [number, number, number];
  normalSpeed: number;
  tangentSpeed: number;
  intensity: number;
  /** Mass-derived acoustic size proxy in metres; not measured geometry. */
  size: number;
  kind: 'impact' | 'scrape';
  material: 'unknown';
}
export interface ReceivedAudioContact extends AudioContact { receivedAtMs: number }

/** Strictly bounded, additive datagram format. Reject the whole malformed
 * packet before touching state. Neither event positions nor levels may be NaN. */
export function decodeAudioContacts(bytes: Uint8Array): AudioContact[] {
  if (bytes.length < 8 || bytes[0] !== PKT_AUDIO_CONTACTS || bytes[1] !== 1 || bytes[3] !== 0 || bytes[2] > AUDIO_CONTACT_MAX_RECORDS || bytes.length !== 8 + bytes[2] * AUDIO_CONTACT_RECORD_BYTES) throw new Error('Invalid audio contacts header');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const simTick = v.getUint32(4, true);
  const output: AudioContact[] = [];
  for (let i = 0; i < bytes[2]; i++) {
    const o = 8 + i * AUDIO_CONTACT_RECORD_BYTES;
    if (bytes[o + 8] > 1 || bytes[o + 9] !== 0 || v.getUint16(o + 10, true) !== 0) throw new Error('Invalid audio contact tags');
    const f = Array.from({ length: 10 }, (_, n) => v.getFloat32(o + 12 + n * 4, true));
    if (!f.every(Number.isFinite) || f.slice(6).some(x => x < 0) || f[8] > 1 || f[9] > 100 || f[6] > 10000 || f[7] > 10000 || Math.hypot(f[3], f[4], f[5]) > 1.01) throw new Error('Invalid audio contact values');
    output.push({ simTick, entityA: v.getUint32(o, true), entityB: v.getUint32(o + 4, true), kind: bytes[o + 8] === 0 ? 'impact' : 'scrape', material: 'unknown', position: [f[0], f[1], f[2]], normal: [f[3], f[4], f[5]], normalSpeed: f[6], tangentSpeed: f[7], intensity: f[8], size: f[9] });
  }
  return output;
}

let newestTick: number | null = null;
let pending: ReceivedAudioContact[] = [];
const recentEntities = new Map<number, number>();
let receivedAtMs = -Infinity;

export function ingestAudioContacts(bytes: Uint8Array, atMs = performance.now()): void {
  const records = decodeAudioContacts(bytes);
  if (!Number.isFinite(atMs)) return;
  const tick = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  // Unsigned half-range comparison handles tick wrap and unordered datagrams.
  if (newestTick !== null && ((tick - newestTick) | 0) <= 0) return;
  newestTick = tick;
  for (const record of records) {
    pending.push({ ...record, receivedAtMs: atMs });
    for (const id of [record.entityA, record.entityB]) {
      if (id === 0) continue; // An unlabelled static ground is not every entity.
      recentEntities.delete(id);
      recentEntities.set(id, atMs);
    }
  }
  if (records.length) receivedAtMs = atMs;
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  for (const [id, time] of recentEntities) if (atMs - time > EXPIRY_MS) recentEntities.delete(id);
  while (recentEntities.size > MAX_RECENT_ENTITIES) recentEntities.delete(recentEntities.keys().next().value!);
}

/** Drain once per presented audio frame. Scrapes refresh a persistent emitter;
 * the renderer should expire it after 300 ms without refresh (no stop packet). */
export function drainAudioContacts(nowMs = performance.now(), maxAgeMs = EXPIRY_MS): ReceivedAudioContact[] {
  const output = pending.filter(record => nowMs - record.receivedAtMs <= maxAgeMs && nowMs >= record.receivedAtMs);
  pending = pending.filter(record => record.receivedAtMs > nowMs);
  return output;
}

/** Pass an entity ID when suppressing a pose-derived fallback. Native GPU
 * chunks have no CPU contact reports and must retain their fallback. */
export function hasRecentAudioContacts(nowMs = performance.now(), entityId?: number): boolean {
  const time = entityId === undefined ? receivedAtMs : recentEntities.get(entityId) ?? -Infinity;
  return nowMs >= time && nowMs - time <= EXPIRY_MS;
}

export function resetAudioContacts(): void {
  newestTick = null;
  pending = [];
  recentEntities.clear();
  receivedAtMs = -Infinity;
}

/** Match PhysX entity namespaces without conflating plain per-kind snapshot
 * user IDs. City topology already uses full namespaced keys. */
export function contactEntityId(kind: 'dynamic' | 'vehicle', id: number): number {
  return ((kind === 'dynamic' ? 0x20000000 : 0x60000000) | (id & 0x0fffffff)) >>> 0;
}
export function contactEntityParts(entity: number): { kind: 'dynamic' | 'vehicle' | 'city' | 'other'; id: number } {
  const namespace = (entity >>> 28) & 15;
  if (namespace === 2) return { kind: 'dynamic', id: entity & 0x0fffffff };
  if (namespace === 6) return { kind: 'vehicle', id: entity & 0x0fffffff };
  if (namespace === 8) return { kind: 'city', id: entity >>> 0 };
  return { kind: 'other', id: entity >>> 0 };
}
