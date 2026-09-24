// CityClient invariant tests: the reorder guard, baseline generations, the
// settle/wake window, promotion continuity, and resync requests.
//
// These cover the pose-application logic that the ledger tests do not reach.
// The client's packet entry point takes encoded bytes and wire.ts ships only
// decoders, so — as in topology.test.ts — messages are built as decoded objects
// and handed to the internal handlers.

import { describe, expect, it, vi } from 'vitest';

import { CityClient } from './cityClient';
import { advanceCityPoses, CityPoseStore, initCityPoses, newCityPoseFrameState } from './cityPoseStore';
import type { LoadedCityManifest, CityManifest } from './manifest';
import { bodyKey } from './topology';
import { RecordMode } from './wire';
import type { ChunksDatagram, TopologyMessage, BaselineMessage } from './wire';
import type { Quat, Vec3 } from './vec';

const IDENTITY: Quat = [0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];

/**
 * Reaches the decoded-object handlers behind `handlePacket`, which only accepts
 * encoded bytes. Mirrors how topology.test.ts drives the ledger directly.
 */
interface CityClientInternals {
  handleChunks(datagram: ChunksDatagram): void;
  handleBaseline(message: BaselineMessage): void;
  bodies: Map<number, unknown>;
  settledAtTick: Map<number, number>;
}
const internals = (client: CityClient): CityClientInternals =>
  client as unknown as CityClientInternals;

const manifest = (): CityManifest => ({
  version: 1,
  structures: [
    {
      structureId: 0,
      worldPosition: [0, 0, 0],
      worldRotation: [0, 0, 0, 1],
      chunks: [0, 1, 2, 3].map((node) => ({
        nodeIndex: node,
        centroid: [0, node + 0.5, 0],
        mass: node === 0 ? 0 : 10,
        volume: 1,
        size: [1, 1, 1],
        geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
        radius: 0.87,
        support: node === 0,
      })),
      bonds: [0, 1, 2].map((i) => ({
        bondIndex: i,
        node0: i,
        node1: i + 1,
        centroid: [0, i + 1, 0],
        normal: [0, 1, 0],
        area: 1,
      })),
    },
  ],
});

const loaded = (): LoadedCityManifest => ({
  manifest: manifest(),
  hashHex: 'a'.repeat(64),
  totalChunks: 4,
  totalBonds: 3,
});

function makeClient(): { client: CityClient; resyncs: Uint8Array[] } {
  const resyncs: Uint8Array[] = [];
  const client = new CityClient(loaded(), (bytes) => resyncs.push(bytes));
  return { client, resyncs };
}

/**
 * Let the sample clock reach every held topology message.
 *
 * Topology is queued and applied when the pose clock reaches its tick, so that
 * a migration's new island basis lands in the same frame as the poses that were
 * simulated under it. In production that wait is the playout delay; here it
 * would mean feeding poses forward just to advance a clock, so the tests reach
 * past it and say plainly that this is the moment the message applies.
 */
function flushTopology(client: CityClient): void {
  (client as unknown as { drainPendingTopology(tick: number): void })
    .drainPendingTopology(Number.MAX_SAFE_INTEGER);
}

/** Establishes the join baseline; topology is refused until this runs. */
function bootstrap(client: CityClient, topoSeq = 0): void {
  pendingBootstrap = {
    simTick: 1,
    manifestHashHex: 'a'.repeat(64),
    baselineId: 1,
    topoSeq,
    structures: [],
    islands: [],
  } as unknown as import('./wire').BootstrapMessage;
  client.handlePacket(new Uint8Array([122])); // PKT_CITY_BOOTSTRAP
}

/** Promotes nodes onto their own island so datagrams for it can be applied. */
function promote(
  client: CityClient,
  topoSeq: number,
  islandId: number,
  nodes: number[],
  position: Vec3,
  simTick = 10,
): void {
  const message: TopologyMessage = {
    topoSeq,
    simTick,
    batches: [
      {
        structureId: 0,
        brokenBondIndices: [],
        promotions: [
          {
            structureId: 0,
            islandId,
            nodes,
            position,
            rotation: IDENTITY,
            linearVelocity: ZERO,
            angularVelocity: ZERO,
          },
        ],
        retiredIslandIds: [],
        migrations: [],
      },
    ],
    settled: [],
    wakes: [],
  };
  client.topology.apply(message);
}

function datagram(
  simTick: number,
  bodyEntity: number,
  position: Vec3,
  overrides: Partial<ChunksDatagram['records'][number]> = {},
): ChunksDatagram {
  return {
    sequence: simTick,
    baselineId: 0,
    simTick,
    records: [
      {
        bodyEntity,
        mode: RecordMode.Absolute,
        flags: 0,
        position,
        rotation: IDENTITY,
        linearVelocity: ZERO,
        angularVelocity: ZERO,
        ...overrides,
      } as ChunksDatagram['records'][number],
    ],
  };
}

describe('CityClient pose application', () => {
  it.each([
    [0, 0x8000_0007], [1, 0x8010_0007], [2, 0x8020_0007],
    [3, 0x8030_0007], [64, 0x8400_0007], [254, 0x8fe0_0007],
  ])('applies server motion IDs to structure %i independently', (structureId, wireId) => {
    // Literal IDs from destruction/src/ids.rs, deliberately not bodyKey():
    // using the same helper for both producer and consumer hid a 22/20-bit mismatch.
    const source = loaded();
    source.manifest.structures = [
      {...manifest().structures[0], structureId},
      {...manifest().structures[0], structureId: structureId === 0 ? 1 : 0},
    ];
    source.totalChunks = 8;
    source.totalBonds = 6;
    const client = new CityClient(source, () => {});
    client.topology.apply({
      topoSeq: 1, simTick: 10,
      batches: [{structureId, brokenBondIndices: [], retiredIslandIds: [], migrations: [],
        promotions: [{structureId, islandId: 7, nodes: [1], position: [0, 5, 0],
          rotation: IDENTITY, linearVelocity: ZERO, angularVelocity: ZERO}]}],
      settled: [], wakes: [],
    });
    internals(client).handleChunks(datagram(20, wireId, [0, 3, 0]));
    expect(internals(client).bodies.has(wireId)).toBe(true);
    client.samplePresentation(performance.now() + 5000);
    expect(client.topology.body(wireId)?.position[1]).toBeCloseTo(3, 2);
    const untouched = client.topology.slotOf(structureId === 0 ? 1 : 0, 1);
    expect(client.topology.chunkWorldPose(untouched).position).toEqual([0, 1.5, 0]);
  });

  it('ignores a reordered datagram that would rewind a body', () => {
    const { client } = makeClient();
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    internals(client).handleChunks(datagram(20, key, [0, 5, 0]));
    internals(client).handleChunks(datagram(30, key, [0, 3, 0]));
    // Arrives late, encoded before the tick-30 record.
    internals(client).handleChunks(datagram(25, key, [0, 99, 0]));

    // Sampled first, because that is how the ledger is read in production: a
    // new track starts at the pose its chunks are already drawn at and the
    // records glide it from there, so the ledger between frames holds the
    // seeded pose rather than the newest record. What this test is about is
    // the REORDERED record, and it must leave no trace either way -- 99 is
    // nowhere near the path from 5 to 3.
    client.samplePresentation(performance.now() + 5000);
    const y = client.topology.body(key)?.position[1] ?? 0;
    expect(y).toBeGreaterThan(2.5);
    expect(y).toBeLessThan(5.5);
  });

  it('is idempotent when the same datagram is delivered twice', () => {
    const { client } = makeClient();
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    const packet = datagram(30, key, [0, 4, 0]);
    internals(client).handleChunks(packet);
    internals(client).handleChunks(packet);

    // Twice must be the same as once. Sampled, for the reason above.
    client.samplePresentation(performance.now() + 5000);
    const twice = client.topology.body(key)?.position[1] ?? 0;

    const { client: single } = makeClient();
    promote(single, 1, 1, [1, 2], [0, 5, 0]);
    internals(single).handleChunks(datagram(30, key, [0, 4, 0]));
    single.samplePresentation(performance.now() + 5000);
    expect(twice).toBeCloseTo(single.topology.body(key)?.position[1] ?? 0, 5);
  });

  it('drops a delta whose baseline generation has been evicted, then recovers on the next absolute', () => {
    const { client } = makeClient();
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    // Three generations: only the newest two survive, so generation 1 is gone.
    for (const id of [1, 2, 3]) {
      internals(client).handleBaseline({
        baselineId: id,
        records: [{ bodyEntity: key, position: [0, 5, 0] }],
      } as BaselineMessage);
    }
    const stale: ChunksDatagram = {
      ...datagram(30, key, [0, 1, 0], { mode: RecordMode.Delta }),
      baselineId: 1,
    };
    // The stale delta must leave no mark: 1 is nowhere near where this body is.
    internals(client).handleChunks(stale);
    client.samplePresentation(performance.now() + 5000);
    expect(client.topology.body(key)?.position[1]).toBeGreaterThan(4);

    // And the next absolute record is taken, gliding the body to 7. Sampled,
    // because a track now starts at the pose its chunks are drawn at and the
    // records move it from there rather than replacing it outright.
    internals(client).handleChunks(datagram(31, key, [0, 7, 0]));
    client.samplePresentation(performance.now() + 10000);
    expect(client.topology.body(key)?.position[1]).toBeCloseTo(7, 1);
  });

  it('does not let a pre-settle datagram roll a body back after it wakes', () => {
    const { client } = makeClient();
    bootstrap(client);
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);
    internals(client).handleChunks(datagram(40, key, [0, 2, 0]));

    // Settle at tick 50 with the authoritative rest pose, then wake at 60.
    // Both go through handlePacket so the real settle/wake bookkeeping runs.
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 2,
        simTick: 50,
        batches: [],
        settled: [{ structureId: 0, islandId: 1, position: [0, 1, 0], rotation: IDENTITY }],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 3,
        simTick: 60,
        batches: [],
        settled: [],
        wakes: [{ structureId: 0, islandSerial: 1 }],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    // Encoded at tick 45, before the settle, but arriving after the wake.
    internals(client).handleChunks(datagram(45, key, [0, 42, 0]));

    expect(client.topology.body(key)?.position[1]).not.toBeCloseTo(42, 1);
  });
});

describe('CityClient promotion continuity', () => {
  it('keeps a promoted island where its chunks were already drawn', () => {
    const { client } = makeClient();
    bootstrap(client);
    const supportKey = bodyKey(0, 0);
    const islandKey = bodyKey(0, 1);

    // The intact structure has been streaming, so its chunks are drawn at a
    // pose the client has actually presented.
    internals(client).handleChunks(datagram(100, supportKey, [0, 0, 0]));
    client.samplePresentation(performance.now());
    const slot = client.topology.slotOf(0, 2);
    const drawnBefore = client.topology.chunkWorldPose(slot).position;

    // Nodes 1-2 fracture away. The promotion pose is where the server has the
    // island at the fracture tick, which is ahead of what has been drawn.
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 2,
        simTick: 101,
        batches: [
          {
            structureId: 0,
            brokenBondIndices: [],
            promotions: [
              {
                structureId: 0,
                islandId: 1,
                nodes: [1, 2],
                position: [0, -0.6, 0],
                rotation: IDENTITY,
                linearVelocity: ZERO,
                angularVelocity: ZERO,
              },
            ],
            retiredIslandIds: [],
            migrations: [],
          },
        ],
        settled: [],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);
    // The next presented frame is what the player actually sees.
    client.samplePresentation(performance.now());

    const drawnAfter = client.topology.chunkWorldPose(slot).position;
    const jump = Math.hypot(
      drawnAfter[0] - drawnBefore[0],
      drawnAfter[1] - drawnBefore[1],
      drawnAfter[2] - drawnBefore[2],
    );
    // A chunk is the same object either side of the fracture: it must not
    // teleport when the island it belongs to is promoted.
    expect(jump).toBeLessThan(0.01);
    // And it must be presentable immediately, not only once a datagram lands.
    expect(internals(client).bodies.has(islandKey)).toBe(true);
  });

});

describe('CityClient topology anomalies', () => {
  it('requests a resync when a migration names an island it does not have', () => {
    const { client, resyncs } = makeClient();
    bootstrap(client);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    const message = {
      topoSeq: 2,
      simTick: 20,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [],
          promotions: [],
          retiredIslandIds: [],
          // Island 7 was never promoted here.
          migrations: [{ node: 2, fromIslandSerial: 1, toIslandSerial: 7 }],
        },
      ],
      settled: [],
      wakes: [],
    } as unknown as TopologyMessage;

    client.handlePacket(encodeAsTopology(message));
    flushTopology(client);

    expect(resyncs.length).toBe(1);
  });

  it('drops a retired island\'s presentation track', () => {
    const { client } = makeClient();
    bootstrap(client);
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);
    internals(client).handleChunks(datagram(30, key, [0, 4, 0]));
    expect(internals(client).bodies.has(key)).toBe(true);

    client.handlePacket(
      encodeAsTopology({
        topoSeq: 2,
        simTick: 40,
        batches: [
          {
            structureId: 0,
            brokenBondIndices: [],
            promotions: [],
            retiredIslandIds: [1],
            migrations: [],
          },
        ],
        settled: [],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    expect(internals(client).bodies.has(key)).toBe(false);
  });
});

/**
 * `handlePacket` dispatches on the packet kind byte and then decodes. These
 * tests need the topology branch's surrounding logic (resync, settles, retires),
 * so the decode step is stubbed to return the message that was built here.
 */
function encodeAsTopology(message: TopologyMessage): Uint8Array {
  pendingTopology = message;
  return new Uint8Array([120]); // PKT_CITY_TOPOLOGY
}
let pendingTopology: TopologyMessage | null = null;
let pendingBootstrap: import('./wire').BootstrapMessage | null = null;

vi.mock('./wire', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wire')>();
  return {
    ...actual,
    decodeTopology: (bytes: Uint8Array) => {
      if (pendingTopology && bytes.length === 1) {
        const message = pendingTopology;
        pendingTopology = null;
        return message;
      }
      return actual.decodeTopology(bytes);
    },
    decodeBootstrap: (bytes: Uint8Array) => {
      if (pendingBootstrap && bytes.length === 1) {
        const message = pendingBootstrap;
        pendingBootstrap = null;
        return message;
      }
      return actual.decodeBootstrap(bytes);
    },
  };
});

describe('CityClient bootstrap integrity', () => {
  it('does not silently accept a topology stream when the join bootstrap never arrived', () => {
    const { client, resyncs } = makeClient();

    // The server always sends a bootstrap on join. If it was dropped or lost,
    // the first live topology message is the only evidence — its sequence
    // number is far from zero. Accepting it silently leaves every pre-join
    // fracture invisible forever: settled islands never stream again.
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 500,
        simTick: 9000,
        batches: [
          {
            structureId: 0,
            brokenBondIndices: [2],
            promotions: [
              {
                structureId: 0,
                islandId: 41,
                nodes: [3],
                position: [0, 1, 0],
                rotation: IDENTITY,
                linearVelocity: ZERO,
                angularVelocity: ZERO,
              },
            ],
            retiredIslandIds: [],
            migrations: [],
          },
        ],
        settled: [],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    expect(resyncs.length).toBe(1);
  });

  it('accepts the stream normally once a bootstrap has established the baseline', () => {
    const { client, resyncs } = makeClient();
    bootstrap(client, 7);

    client.handlePacket(
      encodeAsTopology({
        topoSeq: 8,
        simTick: 110,
        batches: [],
        settled: [],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    expect(resyncs.length).toBe(0);
    expect(client.topology.lastSeq()).toBe(8);
  });
});

describe('CityClient repaint requests', () => {
  it('queues a repaint for a body that settles (its pose changed without streaming)', () => {
    const { client } = makeClient();
    bootstrap(client);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);
    client.drainRepaint(); // clear bootstrap + promotion noise

    client.handlePacket(
      encodeAsTopology({
        topoSeq: 2,
        simTick: 50,
        batches: [],
        settled: [{ structureId: 0, islandId: 1, position: [0, 1, 0], rotation: IDENTITY }],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    const repaint = client.drainRepaint();
    expect(repaint.all).toBe(false);
    expect(repaint.bodies).toContain(bodyKey(0, 1));
  });

  it('requests a full repaint after a bootstrap replaces the whole ledger', () => {
    const { client } = makeClient();
    bootstrap(client);
    const repaint = client.drainRepaint();
    expect(repaint.all).toBe(true);
  });

  it('drains to empty', () => {
    const { client } = makeClient();
    bootstrap(client);
    client.drainRepaint();
    const second = client.drainRepaint();
    expect(second.all).toBe(false);
    expect(second.bodies).toHaveLength(0);
  });
});

describe('CityClient destruction dust', () => {
  it('queues dust sources for an applied fracture, and drains to empty', () => {
    const { client } = makeClient();
    bootstrap(client);
    const before = performance.now();
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 1,
        simTick: 10,
        batches: [
          {
            structureId: 0,
            brokenBondIndices: [1],
            promotions: [
              {
                structureId: 0,
                islandId: 1,
                nodes: [2, 3],
                position: [0, 3, 0],
                rotation: IDENTITY,
                linearVelocity: [0, -5, 0],
                angularVelocity: [0, 0, 0],
              },
            ],
            retiredIslandIds: [],
            migrations: [],
          },
        ],
        settled: [],
        wakes: [],
      } as unknown as TopologyMessage),
    );
    flushTopology(client);

    const kinds: string[] = [];
    const drained = client.drainDustSources((source) => {
      kinds.push(source.kind);
      expect(source.atMs).toBeGreaterThanOrEqual(before);
      expect(source.structureId).toBe(0);
      expect(source.simTick).toBe(10);
    });
    expect(drained).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain('fracture');
    expect(client.stats().dustSources).toBe(drained);
    expect(client.drainDustSources(() => {})).toBe(0);
  });
});

/**
 * Wire v3: a settled body is owned by the reliable channel.
 *
 * The v2 record path has always known this -- `applyRecord` drops any record
 * at or before a body's settle tick, because "the settle arrived on the
 * reliable channel carrying the authoritative rest pose". The v3 sampling path
 * had no such guard, and v3 makes it matter far more: a parked lane stays
 * SAMPLABLE indefinitely by design, so every frame after a settle the sampled
 * pose overwrote the authoritative one, the next reliable message put it back,
 * and the body oscillated between the two.
 *
 * Measured on an identical scripted collapse: settles disagreeing with the
 * client's pose 118 times on v3 versus 0 on v2, worst displacement 151 m
 * versus 2.4 m.
 */
describe('CityClient wire v3 settled-body guard', () => {
  /** Minimal decoder that reports one lane holding one pose, forever. */
  const parkedLaneDecoder = (pose: [number, number, number]) => ({
    lane_count: () => 1,
    sample_into: (_tick: number, lanes: Uint32Array, poses: Float32Array): number => {
      lanes[0] = 0;
      poses[0] = pose[0];
      poses[1] = pose[1];
      poses[2] = pose[2];
      poses[3] = 0; poses[4] = 0; poses[5] = 0; poses[6] = 1;
      return 1;
    },
    drain_poisoned: () => new Uint32Array(0),
    assign_lane: () => {},
    clear_lane_until: () => {},
    reset_all_lanes: () => {},
    push_payload: () => 0,
  });

  interface V3Internals {
    sampleDebris(renderTick: number, live: Set<number>): Set<number>;
    settledAtTick: Map<number, number>;
    laneToEntity: Map<number, number>;
    entityToLane: Map<number, number>;
  }

  it('does not let a parked lane overwrite an authoritative settled pose', () => {
    const key = bodyKey(0, 1);
    const client = new CityClient(
      loaded(),
      () => {},
      { decoder: parkedLaneDecoder([500, 500, 500]) as never },
    );
    bootstrap(client);
    promote(client, 1, 1, [1], [10, 2, 0]);
    const body = client.topology.body(key)!;
    body.position = [10, 2, 0];

    const v3 = client as unknown as V3Internals;
    v3.laneToEntity.set(0, key);
    v3.entityToLane.set(key, 0);
    // Settled at tick 50 by the reliable channel.
    v3.settledAtTick.set(key, 50);

    // Sampling at a tick the settle already covers must change nothing.
    v3.sampleDebris(50, new Set());
    expect(client.topology.body(key)!.position).toEqual([10, 2, 0]);

    // ...and a sample from BEFORE the settle is older news too.
    v3.sampleDebris(40, new Set());
    expect(client.topology.body(key)!.position).toEqual([10, 2, 0]);
  });

  it('still applies samples once the body wakes past its settle tick', () => {
    const key = bodyKey(0, 1);
    const client = new CityClient(
      loaded(),
      () => {},
      { decoder: parkedLaneDecoder([7, 8, 9]) as never },
    );
    bootstrap(client);
    promote(client, 1, 1, [1], [10, 2, 0]);
    client.topology.body(key)!.position = [10, 2, 0];

    const v3 = client as unknown as V3Internals;
    v3.laneToEntity.set(0, key);
    v3.entityToLane.set(key, 0);
    v3.settledAtTick.set(key, 50);

    // A sample from after the settle is genuinely newer, so it wins.
    v3.sampleDebris(80, new Set());
    expect(client.topology.body(key)!.position[0]).toBeCloseTo(7, 4);
  });
});

describe('CityClient kinetic set', () => {
  // The per-frame walk drops bodies whose tracks have settled and re-admits
  // them on new records. The hazard this pins: a body that settled OUT of the
  // walk receives a fresh record and must resurface -- a miss is a chunk
  // frozen at its old pose for the rest of the match.
  it('stops sampling a settled body and resumes on a fresh record', () => {
    const { client } = makeClient();
    bootstrap(client);
    promote(client, 1, 1, [1], [5, 1, 0]);
    const key = bodyKey(0, 1);
    const kinetic = (client as unknown as { kinetic: Set<number> }).kinetic;

    // The test's promote() drives the topology directly, so the body's track
    // (and kinetic membership) begins at its first record, as in the stream.
    internals(client).handleChunks(datagram(20, key, [5, 1, 0], {
      flags: 1, // RECORD_FLAG_SETTLED_HINT -- marks the snapshot Quiescent
    }));
    expect(kinetic.has(key)).toBe(true);
    client.samplePresentation(performance.now());
    for (let i = 0; i < 240 && kinetic.has(key); i += 1) {
      client.samplePresentation(performance.now() + 10_000 + i * 16);
    }
    expect(kinetic.has(key)).toBe(false);

    // Fresh record: re-admitted, and the new pose is actually presented.
    internals(client).handleChunks(datagram(30, key, [9, 1, 0]));
    expect(kinetic.has(key)).toBe(true);
    let moved = false;
    for (let i = 0; i < 240; i += 1) {
      const live = client.samplePresentation(performance.now() + 20_000 + i * 16);
      if (live.has(key)) moved = true;
    }
    expect(moved).toBe(true);
    const pose = client.topology.body(key);
    expect(pose?.position[0]).toBeCloseTo(9, 0);
  });
});

// ---------------------------------------------------------------------------
// Sync fidelity (docs/mac-metal-session-analysis-2026-09-24.md, items 12, 14).
// A simulated server, link and frame loop on a fake clock: the server ticks at
// `hz`, the city sends every second tick, each datagram arrives after
// `transitMs` +- `jitterMs` (seeded), and frames sample the presentation at
// 120 Hz.
// ---------------------------------------------------------------------------

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The simulated server's first tick (tick 0 never advances the client's anchor). */
const TICK_BASE = 100;

interface SimFrame { nowMs: number; presented: number; newestReceived: number; serverTick: number }

function simulateLink(client: CityClient, opts: {
  hz: number; transitMs: number; jitterMs: number; seconds: number;
  /** [startMs, endMs): the server does not tick (a slow physics step). */
  stall?: [number, number];
  /** Extra records for a datagram of this tick. */
  recordsAt?: (tick: number) => ChunksDatagram['records'];
  /** Reliable packets: [arrivalMs, deliver]. */
  reliable?: Array<[number, () => void]>;
  onFrame?: (frame: SimFrame) => void;
}): SimFrame[] {
  const random = seeded(7);
  const startMs = 1000;
  const tickTimes: number[] = [];
  for (let t = startMs; t < startMs + opts.seconds * 1000; t += 1000 / opts.hz) {
    if (opts.stall && t >= opts.stall[0] && t < opts.stall[1]) continue;
    tickTimes.push(t);
  }
  const events: Array<{ at: number; run: () => void }> = [];
  let newestReceived = -1;
  tickTimes.forEach((sentAt, tick) => {
    if (tick % 2 !== 0) return;
    const at = sentAt + opts.transitMs + (random() * 2 - 1) * opts.jitterMs;
    events.push({
      at,
      run: () => {
        const simTick = TICK_BASE + tick;
        internals(client).handleChunks({ sequence: tick, baselineId: 0, simTick, records: opts.recordsAt?.(simTick) ?? [] });
        newestReceived = Math.max(newestReceived, simTick);
      },
    });
  });
  for (const [at, run] of opts.reliable ?? []) events.push({ at, run });
  const frames: SimFrame[] = [];
  for (let at = startMs; at < startMs + opts.seconds * 1000; at += 1000 / 120) {
    events.push({
      at,
      run: () => {
        client.samplePresentation(at);
        if (newestReceived < 0) return;
        let serverTick = 0;
        while (serverTick + 1 < tickTimes.length && tickTimes[serverTick + 1] <= at) serverTick += 1;
        const frame = { nowMs: at, presented: client.presentedTick(), newestReceived, serverTick: TICK_BASE + serverTick };
        frames.push(frame);
        opts.onFrame?.(frame);
      },
    });
  }
  events.sort((a, b) => a.at - b.at);
  const now = vi.spyOn(performance, 'now');
  try {
    for (const event of events) {
      now.mockReturnValue(event.at);
      event.run();
    }
  } finally {
    now.mockRestore();
  }
  return frames;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[values.length >> 1];

describe('CityClient presentation clock (item 12)', () => {
  it('measures the server tick rate without the jitter bias, and presents behind the stream', () => {
    // Netlab's LTE link: 90 +- 35 ms. The server runs slow, at 56 ticks/s.
    const { client } = makeClient();
    const frames = simulateLink(client, { hz: 56, transitMs: 90, jitterMs: 35, seconds: 20 }).slice(240);
    const ahead = frames.filter((f) => f.presented > f.newestReceived).length;
    // The presented tick never passes the newest datagram...
    expect(ahead).toBe(0);
    // ...and sits the playout delay (6 ticks) plus the fastest transit behind
    // the server. The rate estimate's jitter bias had it at 3.5 behind.
    expect(median(frames.map((f) => f.presented - f.serverTick))).toBeLessThan(-7);
  });

  it('stops at the newest streamed tick while the server stalls', () => {
    const { client } = makeClient();
    const stall: [number, number] = [6000, 6250];
    const frames = simulateLink(client, { hz: 60, transitMs: 1, jitterMs: 0, seconds: 8, stall });
    const during = frames.filter((f) => f.nowMs >= stall[0] && f.nowMs < stall[1]);
    expect(during.length).toBeGreaterThan(25);
    expect(Math.max(...during.map((f) => f.presented - f.newestReceived))).toBeLessThanOrEqual(0);
    // And it never steps back.
    for (let i = 1; i < frames.length; i += 1) expect(frames[i].presented).toBeGreaterThanOrEqual(frames[i - 1].presented);
  });

  it('holds behind a promotion the pose stream has shown before its topology arrives', () => {
    const { client } = makeClient();
    const now = vi.spyOn(performance, 'now').mockReturnValue(900);
    bootstrap(client);
    now.mockRestore();
    const U = TICK_BASE + 300; // the first record for island 1: a promotion at U-1 or U
    const topologyArrivesMs = 1000 + ((U - TICK_BASE) / 60) * 1000 + 400; // the reliable stream is 400 ms late
    let appliedAt = Number.POSITIVE_INFINITY;
    const frames = simulateLink(client, {
      hz: 60, transitMs: 5, jitterMs: 0, seconds: 8,
      recordsAt: (tick) => (tick >= U
        ? datagram(tick, bodyKey(0, 1), [0, 10, 0]).records
        : []),
      reliable: [[topologyArrivesMs, () => {
        client.handlePacket(encodeAsTopology({
          topoSeq: 1,
          simTick: U - 1,
          batches: [{
            structureId: 0,
            brokenBondIndices: [1],
            promotions: [{
              structureId: 0, islandId: 1, nodes: [2, 3], position: [0, 10, 0], rotation: IDENTITY,
              linearVelocity: ZERO, angularVelocity: ZERO,
            }],
            retiredIslandIds: [],
            migrations: [],
          }],
          settled: [],
          wakes: [],
        } as unknown as TopologyMessage));
        appliedAt = topologyArrivesMs;
      }]],
    });
    const before = frames.filter((f) => f.nowMs < appliedAt);
    // Never presents the promotion's tick without it: its chunks would be
    // drawn on the body they left.
    expect(Math.max(...before.map((f) => f.presented))).toBeLessThan(U - 1);
    // Released once it lands, without stepping back.
    expect(frames[frames.length - 1].presented).toBeGreaterThan(U + 60);
    for (let i = 1; i < frames.length; i += 1) expect(frames[i].presented).toBeGreaterThanOrEqual(frames[i - 1].presented);
    expect(client.stats().topologyHoldFrames).toBeGreaterThan(0);
  });
});

describe('CityClient retired chunks (item 14)', () => {
  it('stops drawing a retired island\'s chunks once the presentation reaches the retire', () => {
    const { client } = makeClient();
    const now = vi.spyOn(performance, 'now').mockReturnValue(900);
    bootstrap(client);
    client.handlePacket(encodeAsTopology({
      topoSeq: 1,
      simTick: 2,
      batches: [{
        structureId: 0, brokenBondIndices: [1],
        promotions: [{ structureId: 0, islandId: 1, nodes: [2, 3], position: [0, 10, 0], rotation: IDENTITY, linearVelocity: ZERO, angularVelocity: ZERO }],
        retiredIslandIds: [], migrations: [],
      }],
      settled: [], wakes: [],
    } as unknown as TopologyMessage));
    now.mockRestore();
    const radii = new Float32Array(4).fill(0.87);
    const store = new CityPoseStore(4, radii);
    initCityPoses(store, client, radii);
    const state = newCityPoseFrameState(client);
    const slot = client.topology.slotOf(0, 3);
    const RETIRE_TICK = TICK_BASE + 240; // retired at the escape floor, but drawn above the -4 m hide depth
    const retireSentMs = 1000 + ((RETIRE_TICK - TICK_BASE) / 60) * 1000;
    const pose = new Float32Array(7);
    const drawnAt: Array<{ presented: number; drawn: boolean }> = [];
    simulateLink(client, {
      hz: 60, transitMs: 1, jitterMs: 0, seconds: 6,
      recordsAt: (tick) => (tick < RETIRE_TICK ? datagram(tick, bodyKey(0, 1), [0, 10 - tick / 60, 0]).records : []),
      reliable: [[retireSentMs + 1, () => {
        client.handlePacket(encodeAsTopology({
          topoSeq: 2, simTick: RETIRE_TICK,
          batches: [{ structureId: 0, brokenBondIndices: [], promotions: [], retiredIslandIds: [1], migrations: [] }],
          settled: [], wakes: [],
        } as unknown as TopologyMessage));
      }]],
      onFrame: (frame) => {
        advanceCityPoses(store, client, radii, state, frame.nowMs);
        drawnAt.push({ presented: frame.presented, drawn: store.chunkWorldPoseInto(slot, pose) });
      },
    });
    // Drawn until the presentation reaches the retire (v2 applies topology on
    // arrival, a playout delay early), then gone for good.
    expect(drawnAt.filter((f) => f.presented < RETIRE_TICK).every((f) => f.drawn)).toBe(true);
    const after = drawnAt.filter((f) => f.presented >= RETIRE_TICK + 1);
    expect(after.length).toBeGreaterThan(60);
    expect(after.every((f) => !f.drawn)).toBe(true);
    expect(store.bodyIndexOfSlot[slot]).toBe(-1);
  });
});
