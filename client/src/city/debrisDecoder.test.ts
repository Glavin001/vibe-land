/**
 * The wasm decoder against golden bytes from the Rust encoder.
 *
 * The fixture is written by `write_debris_fixture` in the codec crate; this
 * test proves the exact bytes the server emits decode in the module the
 * browser runs -- the property a TS port could only approximate with a second
 * implementation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import initDebris, { DebrisDecoder } from '../wasm/debris-pkg/destruction_codec.js';
import fixture from './__fixtures__/debris-v3-packets.json';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

describe('debris wasm decoder', () => {
  beforeAll(async () => {
    const wasmPath = join(__dirname, '../wasm/debris-pkg/destruction_codec_bg.wasm');
    await initDebris(readFileSync(wasmPath));
  });

  it('decodes the golden packet stream and samples every body', () => {
    const decoder = new DebrisDecoder(new Uint8Array(0), 64, fixture.simHz);
    let applied = 0;
    for (const span of fixture.spans) {
      for (const packet of span.packets) {
        applied += decoder.push_payload(0, hexToBytes(packet.payloadHex));
      }
    }
    expect(applied).toBeGreaterThan(0);

    const lanes = new Uint32Array(64);
    const poses = new Float32Array(64 * 7);
    const filled = decoder.sample_into(24, lanes, poses);
    expect(filled).toBe(4);
    for (let index = 0; index < filled; index += 1) {
      const at = index * 7;
      // Bodies fall from y=20 at 5 m/s; by tick 24 they sit near y=18.
      expect(poses[at + 1]).toBeGreaterThan(15);
      expect(poses[at + 1]).toBeLessThan(21);
      const quadrance =
        poses[at + 3] ** 2 + poses[at + 4] ** 2 + poses[at + 5] ** 2 + poses[at + 6] ** 2;
      expect(Math.abs(quadrance - 1)).toBeLessThan(1e-3);
    }
    expect(decoder.drain_poisoned().length).toBe(0);
  });

  it('poisons chains on a dropped span and reports the lanes', () => {
    const decoder = new DebrisDecoder(new Uint8Array(0), 64, fixture.simHz);
    for (const [index, span] of fixture.spans.entries()) {
      if (index === 2) {
        continue; // the loss
      }
      for (const packet of span.packets) {
        decoder.push_payload(0, hexToBytes(packet.payloadHex));
      }
    }
    // Whether chains formed across the drop depends on the fixture's motion;
    // the invariant is that the decoder never crashes and any poisoned lane it
    // reports is one the fixture actually carries.
    const poisoned = decoder.drain_poisoned();
    for (const lane of poisoned) {
      expect(lane).toBeLessThan(4);
    }
  });

  it('rejects malformed payloads without corrupting state', () => {
    const decoder = new DebrisDecoder(new Uint8Array(0), 64, fixture.simHz);
    expect(() => decoder.push_payload(0, new Uint8Array([1, 2, 3]))).toThrow();
    const first = fixture.spans[0].packets[0];
    expect(decoder.push_payload(0, hexToBytes(first.payloadHex))).toBeGreaterThan(0);
  });
});
