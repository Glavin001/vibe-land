import { describe, expect, it } from 'vitest';
import type { LoadedCityManifest } from './manifest';
import { PerPlayerCityClient, PKT_PP_EVENTS, PKT_PP_KEYFRAMES, type PerPlayerCore } from './perPlayerCityClient';

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

/** A core that accepts every packet and draws nothing. */
const stubCore = (): PerPlayerCore & { ingested: number } => ({
  ingested: 0,
  ingest(this: { ingested: number }) {
    this.ingested += 1;
  },
  advance: () => 0,
  started: () => false,
  body_poses: () => new Float32Array(),
  drain_changes: () => new Uint32Array(),
  structure_flat: () => new Uint32Array(),
  ack: () => new Uint32Array(),
  render_tick: () => 0,
  stats_json: () => '{}',
});

describe('per-player stream stats', () => {
  // The F3 overlay's "city stream" and "datagrams/s" read these. Per-player
  // packets went straight to the core, so a wire-4 match showed 0 Mbps and
  // 0 datagrams/s whatever arrived (the owner's live session, 2026-10-11).
  it('counts per-player packets in the stream bandwidth and datagrams', () => {
    const core = stubCore();
    const client = new PerPlayerCityClient(tinyManifest(), () => {}, core);
    const keyframes = new Uint8Array(200);
    keyframes[0] = PKT_PP_KEYFRAMES;
    const events = new Uint8Array(60);
    events[0] = PKT_PP_EVENTS;
    for (let i = 0; i < 10; i++) {
      client.handlePacket(keyframes);
    }
    client.handlePacket(events);
    expect(core.ingested).toBe(11);
    const stats = client.stats();
    expect(stats.datagramsReceived).toBe(10);
    expect(stats.bytesReceived).toBe(10 * 200 + 60);
  });
});
