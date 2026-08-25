// CityClient invariant tests: the reorder guard, baseline generations, the
// settle/wake window, promotion continuity, and resync requests.
//
// These cover the pose-application logic that the ledger tests do not reach.
// The client's packet entry point takes encoded bytes and wire.ts ships only
// decoders, so — as in topology.test.ts — messages are built as decoded objects
// and handed to the internal handlers.

import { describe, expect, it, vi } from 'vitest';

import { CityClient } from './cityClient';
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
  it('ignores a reordered datagram that would rewind a body', () => {
    const { client } = makeClient();
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    internals(client).handleChunks(datagram(20, key, [0, 5, 0]));
    internals(client).handleChunks(datagram(30, key, [0, 3, 0]));
    // Arrives late, encoded before the tick-30 record.
    internals(client).handleChunks(datagram(25, key, [0, 99, 0]));

    expect(client.topology.body(key)?.position[1]).toBeCloseTo(3, 5);
  });

  it('is idempotent when the same datagram is delivered twice', () => {
    const { client } = makeClient();
    const key = bodyKey(0, 1);
    promote(client, 1, 1, [1, 2], [0, 5, 0]);

    const packet = datagram(30, key, [0, 4, 0]);
    internals(client).handleChunks(packet);
    internals(client).handleChunks(packet);

    expect(client.topology.body(key)?.position[1]).toBeCloseTo(4, 5);
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
    internals(client).handleChunks(stale);
    expect(client.topology.body(key)?.position[1]).toBeCloseTo(5, 5);

    internals(client).handleChunks(datagram(31, key, [0, 7, 0]));
    expect(client.topology.body(key)?.position[1]).toBeCloseTo(7, 5);
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
    client.handlePacket(
      encodeAsTopology({
        topoSeq: 3,
        simTick: 60,
        batches: [],
        settled: [],
        wakes: [{ structureId: 0, islandSerial: 1 }],
      } as unknown as TopologyMessage),
    );

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
