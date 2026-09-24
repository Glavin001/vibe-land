import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/fixtures/match-stats-frame-v1.json';
import { decodeMatchStatsPacket, MATCH_STATS_FIELDS, MATCH_STATS_FRAME_FORMAT } from './matchStatsFrame';
import { PKT_MATCH_STATS } from './sharedConstants';

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A frame with every field present, as a full city match sends. */
function fullFrame(extraFields = 0): Uint8Array {
  const parts: number[] = [PKT_MATCH_STATS, MATCH_STATS_FRAME_FORMAT, 7, 0, 0, 0];
  const count = MATCH_STATS_FIELDS.length + extraFields;
  parts.push(count & 0xff, count >> 8);
  const f32 = (v: number) => Array.from(new Uint8Array(new Float32Array([v]).buffer));
  const u32 = (v: number) => Array.from(new Uint8Array(new Uint32Array([v]).buffer));
  for (const field of MATCH_STATS_FIELDS) {
    if (field.type === 'f') parts.push(...f32(1.5));
    else if (field.type === 'u') parts.push(...u32(9));
    else if (field.type === 'b') parts.push(1);
    else parts.push(2, 0x68, 0x69); // "hi"
  }
  // Fields a newer server appended; this client does not know their types.
  for (let i = 0; i < extraFields; i += 1) parts.push(...f32(99));
  return new Uint8Array(parts);
}

describe('decodeMatchStatsPacket', () => {
  it('decodes the frame the server encodes (shared fixture) to the stats it came from', () => {
    const stats = decodeMatchStatsPacket(fromHex(fixture.hex));
    expect(stats).toEqual({ server_tick: fixture.server_tick, ...fixture.stats });
  });

  it('gives the overlay the same object shape the JSON snapshot had', () => {
    const stats = decodeMatchStatsPacket(fullFrame()) as any;
    expect(stats.server_tick).toBe(7);
    expect(stats.timings.total_ms.avg).toBe(1.5);
    expect(stats.physics_gpu_active).toBe(true);
    expect(stats.server_build).toBe('hi');
    expect(stats.city.awake_bodies).toBe(9);
    expect(stats.city.degraded).toBe(true);
    expect(stats.spans['destruction/native_escaped_bodies'].v).toBe(1.5);
  });

  it('frame is a fraction of the JSON it replaces', () => {
    // ~15 kB of JSON per second before; well under a datagram now.
    expect(fullFrame().length).toBeLessThan(400);
  });

  it('leaves absent fields out instead of reading them as zero', () => {
    const stats = decodeMatchStatsPacket(fromHex(fixture.hex)) as any;
    expect('physics_gpu_wait_ms' in stats).toBe(false);
    expect('sleeping_bodies' in stats.city).toBe(false);
    // Only the span that was sent; no empty objects for the rest.
    expect(Object.keys(stats.spans)).toEqual(['destruction/native_escaped_bodies']);
  });

  it('creates no city object for a match without a city', () => {
    // Every field absent (a lobby match: no city, no spans).
    const parts: number[] = [PKT_MATCH_STATS, MATCH_STATS_FRAME_FORMAT, 1, 0, 0, 0];
    parts.push(MATCH_STATS_FIELDS.length & 0xff, MATCH_STATS_FIELDS.length >> 8);
    for (const field of MATCH_STATS_FIELDS) {
      if (field.type === 'f') parts.push(0x00, 0x00, 0xc0, 0x7f); // NaN
      else if (field.type === 'u') parts.push(0xff, 0xff, 0xff, 0xff);
      else parts.push(0xff);
    }
    expect(decodeMatchStatsPacket(new Uint8Array(parts))).toEqual({ server_tick: 1 });
  });

  it('reads the prefix it knows from a newer server with more fields', () => {
    const stats = decodeMatchStatsPacket(fullFrame(3)) as any;
    expect(stats.city.client_datagrams_ms).toBe(1.5);
  });

  it('still reads the JSON snapshot older servers send', () => {
    const json = new TextEncoder().encode(JSON.stringify({ server_tick: 5, city: { awake_bodies: 3 } }));
    const packet = new Uint8Array(json.length + 1);
    packet[0] = PKT_MATCH_STATS;
    packet.set(json, 1);
    expect(decodeMatchStatsPacket(packet)).toEqual({ server_tick: 5, city: { awake_bodies: 3 } });
  });

  it('refuses truncated frames, unknown formats and broken JSON rather than guessing', () => {
    const frame = fromHex(fixture.hex);
    expect(decodeMatchStatsPacket(frame.subarray(0, frame.length - 1))).toBeNull();
    expect(decodeMatchStatsPacket(frame.subarray(0, 5))).toBeNull();
    const future = frame.slice();
    future[1] = 2;
    expect(decodeMatchStatsPacket(future)).toBeNull();
    expect(decodeMatchStatsPacket(new Uint8Array([PKT_MATCH_STATS, 0x7b, 0x22]))).toBeNull();
    expect(decodeMatchStatsPacket(new Uint8Array([PKT_MATCH_STATS]))).toBeNull();
  });
});
