import { describe, expect, it } from 'vitest';
import capture from './fixtures/rooted-wire.json';
import { CityClient } from './cityClient';
import type { CityManifest, LoadedCityManifest } from './manifest';
import { CityTopology, bodyKey } from './topology';
import { decodeBootstrap, decodeTopology } from './wire';

// Captured from the production PhysX -> CityDestruction -> encoder test in
// destruction/tests/rooted_wire.rs, including a same-tick fracture replay.
const manifest = capture.manifest as unknown as CityManifest;
const initial = decodeBootstrap(Uint8Array.from(capture.packets[0]));
const loaded: LoadedCityManifest = {
  manifest,
  hashHex: initial.manifestHashHex,
  totalChunks: manifest.structures.reduce((n, s) => n + s.chunks.length, 0),
  totalBonds: manifest.structures.reduce((n, s) => n + s.bonds.length, 0),
};

function assertStandingRoots(client: CityClient): void {
  for (const serial of capture.rooted) {
    const body = client.topology.body(bodyKey(0, serial));
    expect(body, `root ${serial}`).toBeDefined();
    expect(body!.settled).toBe(true);
    for (const slot of body!.chunkSlots) {
      const actual = client.topology.chunkWorldPose(slot).position;
      const expected = manifest.structures[0].chunks[slot].centroid;
      expect(Math.hypot(...actual.map((v, axis) => v - expected[axis]))).toBeLessThan(1e-4);
    }
  }
  expect(client.topology.migrateAnomalies.missingDestination).toBe(0);
  expect(client.topology.resyncStructures.size).toBe(0);
  expect(client.stats().settleRejects).toBe(0);
  expect(client.stats().orphanedChunks).toBe(0);
  expect(client.stats().orphanedByRetire).toBe(0);
  const hashes = client.topology.structureHashes();
  for (const { structureId, laneA, laneB } of capture.serverHashes) {
    expect(hashes.get(structureId)).toEqual({ laneA, laneB });
  }
}

describe('rooted fragments from production wire capture', () => {
  it('keeps standing chunks fixed without repairs or motion packets', () => {
    const repairs: Uint8Array[] = [];
    const client = new CityClient(loaded, (packet) => repairs.push(packet));
    for (const packet of capture.packets) {
      client.handlePacket(Uint8Array.from(packet));
      expect(client.topology.migrateAnomalies.missingDestination).toBe(0);
      expect(client.stats().orphanedChunks).toBe(0);
    }
    // Topology is held until the pose clock reaches its tick, so that an
    // island's new basis lands with the poses simulated under it. This capture
    // deliberately has no motion packets, so nothing advances that clock and
    // the wall-clock valve is what releases the batch. Sampling past it is
    // therefore part of what this test asserts: a still city still ends up
    // with exactly these roots, by the slower of the two routes.
    client.samplePresentation(performance.now() + 1500);
    assertStandingRoots(client);
    for (const elapsed of [1516, 2500, 11500]) {
      client.samplePresentation(performance.now() + elapsed);
      assertStandingRoots(client);
    }
    expect(repairs).toEqual([]);
  });

  it('gives a late joiner the same standing poses and membership', () => {
    const client = new CityClient(loaded, () => { throw new Error('unexpected repair'); });
    client.handlePacket(Uint8Array.from(capture.finalBootstrap));
    assertStandingRoots(client);
  });

  it('detects the original omission in the captured migrations', () => {
    const topology = new CityTopology(manifest);
    topology.applyBootstrap(initial);
    for (const packet of capture.packets.slice(1)) {
      const message = decodeTopology(Uint8Array.from(packet));
      for (const batch of message.batches) {
        batch.promotions = batch.promotions.filter((promotion) => !capture.rooted.includes(promotion.islandId));
      }
      topology.apply(message);
    }
    expect(topology.migrateAnomalies.missingDestination).toBeGreaterThan(0);
    expect(topology.resyncStructures.has(0)).toBe(true);
  });
});
