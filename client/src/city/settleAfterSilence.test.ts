import { describe, expect, it } from 'vitest';
import capture from './fixtures/settle-after-silence.json';
import { CityClient } from './cityClient';
import type { CityManifest, LoadedCityManifest } from './manifest';
import { bodyKey } from './topology';
import { decodeBootstrap } from './wire';

// Production encoder bytes from destruction/tests/settle_after_silence_wire.rs
// (regenerate with VIBE_SETTLE_SILENCE_CAPTURE=<path>): a fragment is streamed
// while it is in view, thrown past the camera and out of the 120 m proximity
// radius, so the encoder stops streaming it to this client while it still
// moves, and it settles 65 m from the last pose this client was sent.
//
// To-do item 6 of docs/mac-metal-session-analysis-2026-09-24.md: the client
// took every such settle for a membership disagreement and asked for a
// structure repair, on links with no loss.
const manifest = capture.manifest as unknown as CityManifest;
const initial = decodeBootstrap(Uint8Array.from(capture.packets[0]));
const loaded: LoadedCityManifest = {
  manifest,
  hashHex: initial.manifestHashHex,
  totalChunks: manifest.structures.reduce((n, s) => n + s.chunks.length, 0),
  totalBonds: manifest.structures.reduce((n, s) => n + s.bonds.length, 0),
};

describe('a settle after the stream went silent (production wire)', () => {
  it('is applied without asking for a repair, and the ledger matches the server', () => {
    const upstream: Uint8Array[] = [];
    const client = new CityClient(loaded, (bytes) => upstream.push(bytes));
    for (const packet of capture.packets) {
      client.handlePacket(Uint8Array.from(packet));
    }
    const stats = client.stats();
    expect(stats.resyncRequestsSent, 'asked the server for a repair').toBe(0);
    expect(upstream).toEqual([]);
    expect(stats.settleRejects).toBe(0);
    expect(stats.settlesAfterSilence).toBe(1);
    expect(stats.hashChecks).toBeGreaterThan(0);
    expect(stats.hashMismatches).toBe(0);

    // The settle glides the drawn body from where it was last drawn to where
    // the server says it stopped; after the glide the ledger is there.
    const start = performance.now();
    for (let elapsed = 0; elapsed <= 3000; elapsed += 16) {
      client.samplePresentation(start + elapsed);
    }
    const body = client.topology.body(bodyKey(capture.body.structureId, capture.body.islandId))!;
    expect(body.settled).toBe(true);
    const [x, y, z] = capture.settlePosition;
    expect(Math.hypot(body.position[0] - x, body.position[1] - y, body.position[2] - z)).toBeLessThan(0.01);
    expect(client.stats().resyncRequestsSent).toBe(0);
    const hashes = client.topology.structureHashes();
    for (const { structureId, laneA, laneB } of capture.serverHashes) {
      expect(hashes.get(structureId)).toEqual({ laneA, laneB });
    }
  });
});
