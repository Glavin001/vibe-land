import { describe, expect, it, beforeEach } from 'vitest';
import { decodeAudioContacts, ingestAudioContacts, drainAudioContacts, resetAudioContacts, hasRecentAudioContacts, AUDIO_CONTACT_RECORD_BYTES, contactEntityId, contactEntityParts } from './contactStream';

function packet(tick = 3, count = 1): Uint8Array {
  const data = new Uint8Array(8 + count * 52);
  const v = new DataView(data.buffer);
  data[0] = 131; data[1] = 1; data[2] = count;
  v.setUint32(4, tick, true);
  for (let i = 0; i < count; i++) {
    const o = 8 + i * 52;
    v.setUint32(o, i + 1, true); v.setUint32(o + 4, 0, true);
    data[o + 8] = 0; data[o + 9] = 0;
    [1, 2, 3, 0, 1, 0, 5, 2, .7, 1].forEach((n, k) => v.setFloat32(o + 12 + k * 4, n, true));
  }
  return data;
}

beforeEach(resetAudioContacts);
describe('bounded authoritative contact stream', () => {
  it('decodes versioned contacts including physical contact speeds', () => {
    expect(AUDIO_CONTACT_RECORD_BYTES).toBe(52);
    expect(decodeAudioContacts(packet())).toEqual([expect.objectContaining({ simTick: 3, entityA: 1, entityB: 0, kind: 'impact', material: 'unknown', position: [1, 2, 3], normal: [0, 1, 0], normalSpeed: 5, tangentSpeed: 2 })]);
  });
  it('rejects truncation, unknown versions, excessive counts, trailing bytes and nonfinite values', () => {
    const bad = packet(); bad[1] = 2;
    const nan = packet(); new DataView(nan.buffer).setFloat32(20, NaN, true);
    for (const bytes of [packet().subarray(0, 59), bad, packet(3, 17), new Uint8Array([...packet(), 0]), nan]) expect(() => decodeAudioContacts(bytes)).toThrow();
  });
  it('deduplicates reordered packets, preserves receipt clock, and scopes fallback suppression', () => {
    ingestAudioContacts(packet(9), 100);
    ingestAudioContacts(packet(9), 110);
    ingestAudioContacts(packet(6), 120);
    expect(hasRecentAudioContacts(150, 1)).toBe(true);
    expect(hasRecentAudioContacts(150, 999)).toBe(false);
    const result = drainAudioContacts(150);
    expect(result).toHaveLength(1);
    expect(result[0].receivedAtMs).toBe(100);
    expect(drainAudioContacts(150)).toEqual([]);
    expect(hasRecentAudioContacts(500, 1)).toBe(false);
  });
  it('expires stale sounds and caps pending memory during a suspended audio context', () => {
    for (let tick = 3; tick < 303; tick += 3) ingestAudioContacts(packet(tick, 16), 100);
    expect(drainAudioContacts(200).length).toBeLessThanOrEqual(128);
    ingestAudioContacts(packet(303), 300);
    expect(drainAudioContacts(1000)).toEqual([]);
  });
  it('keeps physics entity namespaces separate from snapshot user IDs', () => {
    expect(contactEntityId('dynamic', 7)).toBe(0x20000007);
    expect(contactEntityId('vehicle', 7)).toBe(0x60000007);
    expect(contactEntityParts(0x60000007)).toEqual({ kind: 'vehicle', id: 7 });
    expect(contactEntityParts(0x80000007)).toEqual({ kind: 'city', id: 0x80000007 });
    const bytes=packet(3);new DataView(bytes.buffer).setUint32(8,contactEntityId('vehicle',7),true);
    ingestAudioContacts(bytes,100);
    expect(hasRecentAudioContacts(150,7)).toBe(false);
    expect(hasRecentAudioContacts(150,contactEntityId('dynamic',7))).toBe(false);
    expect(hasRecentAudioContacts(150,contactEntityId('vehicle',7))).toBe(true);
  });
  it('supports uint32 simulation tick rollover and replay reset', () => {
    ingestAudioContacts(packet(0xfffffffe), 100);
    ingestAudioContacts(packet(1), 120);
    expect(drainAudioContacts(130)).toHaveLength(2);
    resetAudioContacts();
    ingestAudioContacts(packet(1), 150);
    expect(drainAudioContacts(160)).toHaveLength(1);
  });
});
