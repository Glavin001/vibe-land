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
  hash_mismatches: () => 0,
  vehicle_groups_version: () => 0,
  vehicle_groups: () => new Float32Array(),
  set_vehicle_parts: () => {},
  advance_vehicles: () => {},
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

describe('per-player bodies at rest', () => {
  // A settled body is written once and then left alone; but a body woken
  // and settled again between two frames rests at a new pose from a new
  // tick, and must be written and repainted again (it was left drawn where
  // it first settled).
  it('repaints a body that settles again at a new pose, and only then', () => {
    let frame: number[] = [];
    const core = {
      ...stubCore(),
      advance: () => 300,
      started: () => true,
      body_poses: () => Float32Array.from(frame),
      hash_mismatches: () => 0,
    };
    const client = new PerPlayerCityClient(tinyManifest(), () => {}, core);
    const repaints = () => client.drainRepaint().bodies.length;
    const rest = (tick: number, x: number) => [0, 1, x, 0.5, 0, 0, 0, 0, 1, tick + 1];
    frame = rest(100, 1.0);
    client.samplePresentation(0);
    expect(repaints()).toBe(1);
    client.samplePresentation(16);
    expect(repaints()).toBe(0);
    frame = rest(200, 2.0);
    client.samplePresentation(33);
    expect(repaints()).toBe(1);
  });
});

describe('per-player car debris', () => {
  // Wire 4 streams a car's broken-off parts as bodies placing each group's
  // centre of mass; the car draws each part through the map from its car
  // frame: translation = position - R * centre.
  it('hands each car its detached parts as car-frame maps', () => {
    let version = 1;
    let groups = Float32Array.from([0x8000 + 3, 1, /* body */ 2, /* centre */ 0.5, 0, 1, /* members */ 2, 2, 5]);
    // Body 2 of car 3 at (10, 1, -4), turned 90 degrees about y.
    const s = Math.SQRT1_2;
    const poses = Float32Array.from([0x8000 + 3, 2, 10, 1, -4, 0, s, 0, s, 0]);
    const core = {
      ...stubCore(),
      advance: () => 300,
      started: () => true,
      body_poses: () => poses,
      vehicle_groups_version: () => version,
      vehicle_groups: () => groups,
    };
    const client = new PerPlayerCityClient(tinyManifest(), () => {}, core);
    const seen: Array<[number, Array<{ part: number; position: number[]; rotation: number[] }>]> = [];
    client.setVehicleDebrisListener((handle, parts) => seen.push([handle, parts]));
    client.samplePresentation(0);
    expect(seen).toHaveLength(1);
    const [handle, parts] = seen[0];
    expect(handle).toBe(3);
    expect(parts.map((p) => p.part)).toEqual([2, 5]);
    // R * (0.5, 0, 1) for 90 degrees about y is (1, 0, -0.5).
    for (const p of parts) {
      expect(p.position[0]).toBeCloseTo(9, 5);
      expect(p.position[1]).toBeCloseTo(1, 5);
      expect(p.position[2]).toBeCloseTo(-3.5, 5);
      expect(p.rotation).toEqual([0, Math.fround(s), 0, Math.fround(s)]);
    }
    // Its groups gone (a reset): the car is told its parts are back on it.
    version = 2;
    groups = new Float32Array();
    seen.length = 0;
    client.samplePresentation(16);
    expect(seen).toEqual([[3, []]]);
  });

  // The floor of a car's groups: each part's hull points in the car frame,
  // as the server takes them (part + shape position + vertex, in f32).
  it('hands the core each part hull as car-frame points', () => {
    const calls: Array<[number, number[]]> = [];
    const core = { ...stubCore(), set_vehicle_parts: (structure: number, flat: Float32Array) => calls.push([structure, Array.from(flat)]) };
    const client = new PerPlayerCityClient(tinyManifest(), () => {}, core);
    client.setVehicleParts(4, [
      { position: [1, 0, 0], shapes: [{ position: [0, 1, 0], vertices: [[0, 0, 0.5], [0, 0, -0.5]] }, { position: [0, 0, 0], vertices: [[2, 0, 0]] }] },
      { position: [0, 0, 0], shapes: [] },
    ]);
    expect(calls).toEqual([[0x8000 + 4, [2, 3, 1, 1, 0.5, 1, 1, -0.5, 3, 0, 0, 0]]]);
  });
});
