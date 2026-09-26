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
import type { CityAudioImpact } from '../audio/cityImpactSources';
import type { DustSource } from './destructionEvents';

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

describe('CityClient audio observations',()=>{
  it.each([[6,1000,.8,1],[2,5000,.75,0]])('carries a %sm/s stop from actual decoded city motion into the independent audio queue',(speed,mass,minIntensity,dustCount)=>{
    const source=loaded();
    Object.assign(source.manifest.structures[0].chunks[1],{mass,radius:2,material:1});
    const client=new CityClient(source,()=>{}),key=bodyKey(0,1);
    promote(client,1,1,[1],[4,4,0]);
    client.observeAudio(true);
    internals(client).handleChunks(datagram(20,key,[4,4,0],{linearVelocity:[0,-speed,0]}));
    internals(client).handleChunks(datagram(23,key,[4,3.7,0],{linearVelocity:[0,0,0]}));
    const heard:Array<{source:DustSource;impact?:CityAudioImpact}>=[];
    client.drainAudioSources((source,impact)=>heard.push({source:{...source},impact}));
    expect(heard).toHaveLength(1);
    expect(heard[0].source).toMatchObject({kind:'impact',simTick:23,structureId:0});
    expect(heard[0].impact).toMatchObject({entityId:key,mass,size:3,material:1});
    expect(heard[0].impact!.intensity).toBeGreaterThan(minIntensity);
    expect(client.drainDustSources(()=>{})).toBe(dustCount);
    expect(client.drainAudioSources(()=>{})).toBe(0);
  });
  it('clears queued physical evidence when audio observation is disabled',()=>{
    const {client}=makeClient(),key=bodyKey(0,1);
    promote(client,1,1,[1],[4,4,0]);
    client.observeAudio(true);
    internals(client).handleChunks(datagram(20,key,[4,4,0],{linearVelocity:[0,-6,0]}));
    internals(client).handleChunks(datagram(23,key,[4,3.7,0],{linearVelocity:[0,0,0]}));
    client.observeAudio(false);
    client.observeAudio(true);
    expect(client.drainAudioSources(()=>{})).toBe(0);
  });
});

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
let pendingStructureBootstrap: import('./wire').BootstrapMessage | null = null;

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
    decodeStructureBootstrap: (bytes: Uint8Array) => {
      if (pendingStructureBootstrap && bytes.length === 1) {
        const message = pendingStructureBootstrap;
        pendingStructureBootstrap = null;
        return message;
      }
      return actual.decodeStructureBootstrap(bytes);
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
  /** [startMs, endMs): no pose datagram is sent (the rate controller withholds them). */
  suppress?: [number, number];
  /** Ticks between sends (default 2, the 30 Hz stream), or per send time. */
  sendInterval?: number | ((sentAtMs: number) => number);
  /** The predictive horizon trailer every datagram carries (ticks). */
  horizonTicks?: number;
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
    const interval = typeof opts.sendInterval === 'function' ? opts.sendInterval(sentAt) : opts.sendInterval ?? 2;
    if (tick % interval !== 0) return;
    const at = sentAt + opts.transitMs + (random() * 2 - 1) * opts.jitterMs;
    if (opts.suppress && sentAt >= opts.suppress[0] && sentAt < opts.suppress[1]) return;
    events.push({
      at,
      run: () => {
        const simTick = TICK_BASE + tick;
        internals(client).handleChunks({
          sequence: tick, baselineId: 0, simTick, records: opts.recordsAt?.(simTick) ?? [],
          ...(opts.horizonTicks !== undefined ? { horizonTicks: opts.horizonTicks } : {}),
        });
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

// ---------------------------------------------------------------------------
// Topology copies on the datagram lane (destruction/src/encoder.rs
// `topology_datagram_copies`) and the adaptive playout delay.
// ---------------------------------------------------------------------------

function leb128(out: number[], value: number): void {
  let v = value >>> 0;
  for (;;) {
    const byte = v & 0x7f;
    v >>>= 7;
    if (v === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

/** A PKT_CITY_TOPOLOGY packet promoting `nodes` of structure 0 onto `islandId`. */
function topologyBytes(topoSeq: number, simTick: number, islandId: number, nodes: number[], y = 5): Uint8Array {
  const out: number[] = [120, 2];
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const i16 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff);
  u32(topoSeq);
  u32(simTick);
  out.push(1, 0); // one section
  out.push(1); // fracture
  leb128(out, 0); // structure
  leb128(out, 0); // no broken bonds
  leb128(out, 1); // one promotion
  leb128(out, islandId);
  leb128(out, nodes.length);
  nodes.forEach((node, i) => leb128(out, i === 0 ? node : node - nodes[i - 1]));
  [0, 0, 0, 0, y * 100, 0].forEach(i16); // region, local (cm)
  u32(3); // identity quaternion
  [0, 0, 0, 0, 0, 0].forEach(i16); // velocities
  leb128(out, 0); // retired
  leb128(out, 0); // migrations
  return new Uint8Array(out);
}

/** A record-less chunk datagram carrying topology parts, as the encoder sends them. */
function copyDatagram(simTick: number, parts: Array<{ topoSeq: number; part: number; parts: number; bytes: Uint8Array }>): ChunksDatagram {
  return { sequence: 0, baselineId: 0, simTick, records: [], topologyParts: parts };
}

describe('CityClient topology copies', () => {
  it('applies a copy that beats its reliable message, once', () => {
    const { client, resyncs } = makeClient();
    bootstrap(client);
    const bytes = topologyBytes(1, 10, 1, [2, 3]);
    internals(client).handleChunks(copyDatagram(8, [{ topoSeq: 1, part: 0, parts: 1, bytes }]));
    expect(client.topology.body(bodyKey(0, 1))?.chunkSlots.length).toBe(2);
    expect(client.topology.lastSeq()).toBe(1);
    // The reliable message lands later and changes nothing.
    client.handlePacket(bytes);
    expect(client.topology.lastSeq()).toBe(1);
    const stats = client.stats();
    expect(stats.topologyCopiesApplied).toBe(1);
    expect(stats.topologyReliableAfterCopy).toBe(1);
    expect(stats.topoSeqGaps).toBe(0);
    expect(resyncs).toHaveLength(0);
  });

  it('holds a copy that is ahead of a missing message, then applies both in seq order', () => {
    const { client, resyncs } = makeClient();
    bootstrap(client);
    const first = topologyBytes(1, 10, 1, [3]);
    const second = topologyBytes(2, 12, 2, [2]);
    internals(client).handleChunks(copyDatagram(10, [{ topoSeq: 2, part: 0, parts: 1, bytes: second }]));
    expect(client.topology.lastSeq()).toBe(0);
    expect(client.topology.body(bodyKey(0, 2))).toBeUndefined();
    client.handlePacket(first); // the reliable stream delivers seq 1
    expect(client.topology.lastSeq()).toBe(2);
    expect(client.topology.body(bodyKey(0, 1))).toBeDefined();
    expect(client.topology.body(bodyKey(0, 2))).toBeDefined();
    client.handlePacket(second); // and seq 2, already applied
    expect(client.stats().topoSeqGaps).toBe(0);
    expect(resyncs).toHaveLength(0);
  });

  it('reassembles a copy split across datagrams, in any order', () => {
    const { client } = makeClient();
    bootstrap(client);
    const bytes = topologyBytes(1, 10, 1, [2, 3]);
    const cut = 9;
    internals(client).handleChunks(copyDatagram(8, [{ topoSeq: 1, part: 1, parts: 2, bytes: bytes.subarray(cut) }]));
    expect(client.topology.lastSeq()).toBe(0);
    internals(client).handleChunks(copyDatagram(8, [{ topoSeq: 1, part: 0, parts: 2, bytes: bytes.subarray(0, cut) }]));
    expect(client.topology.lastSeq()).toBe(1);
    expect(client.topology.body(bodyKey(0, 1))).toBeDefined();
  });

  it('holds the presentation below a missing message whose first piece arrived', () => {
    // A two-piece copy lost its second piece; the reliable stream brings the
    // message 400 ms late. No record names the new body yet, so only the
    // piece says a promotion is coming, and at which tick.
    const { client } = makeClient();
    const now = vi.spyOn(performance, 'now').mockReturnValue(900);
    bootstrap(client);
    now.mockRestore();
    const U = TICK_BASE + 300;
    const bytes = topologyBytes(1, U, 1, [2, 3]);
    const sentMs = 1000 + ((U - TICK_BASE) / 60) * 1000;
    const arrivesMs = sentMs + 400;
    let appliedAt = Number.POSITIVE_INFINITY;
    const frames = simulateLink(client, {
      hz: 60, transitMs: 5, jitterMs: 0, seconds: 8,
      reliable: [
        [sentMs + 5, () => internals(client).handleChunks(copyDatagram(U, [{ topoSeq: 1, part: 0, parts: 2, bytes: bytes.subarray(0, 12) }]))],
        [arrivesMs, () => { client.handlePacket(bytes); appliedAt = arrivesMs; }],
      ],
    });
    const before = frames.filter((f) => f.nowMs < appliedAt);
    expect(Math.max(...before.map((f) => f.presented))).toBeLessThan(U);
    expect(frames[frames.length - 1].presented).toBeGreaterThan(U + 60);
    for (let i = 1; i < frames.length; i += 1) expect(frames[i].presented).toBeGreaterThanOrEqual(frames[i - 1].presented);
  });

  it('keeps the lead cap while only topology copies arrive', () => {
    // The rate controller withholds a slow link's pose records for a while
    // but the copies keep coming: the presentation must stay at or behind
    // the newest records it has, not run on past the 300 ms lapse.
    const { client } = makeClient();
    const now = vi.spyOn(performance, 'now').mockReturnValue(900);
    bootstrap(client);
    now.mockRestore();
    const quietFrom = 5000;
    const quietTo = 6500;
    const dup = topologyBytes(0, 1, 1, [3]); // seq 0: already applied, ignored
    const frames = simulateLink(client, {
      hz: 60, transitMs: 20, jitterMs: 0, seconds: 8,
      recordsAt: () => [],
      reliable: Array.from({ length: 45 }, (_, i) => {
        const at = quietFrom + i * 33.3;
        const tick = TICK_BASE + Math.floor(((at - 20 - 1000) / 1000) * 60) - 2;
        return [at, () => internals(client).handleChunks(copyDatagram(tick, [{ topoSeq: 0, part: 0, parts: 1, bytes: dup }]))] as [number, () => void];
      }),
      suppress: [quietFrom, quietTo],
    });
    const quiet = frames.filter((f) => f.nowMs >= quietFrom + 300 && f.nowMs < quietTo);
    expect(quiet.length).toBeGreaterThan(100);
    expect(Math.max(...quiet.map((f) => f.presented - f.newestReceived))).toBeLessThanOrEqual(0);
  });
});

/** The adaptive playout delay is off by default (/city?adaptiveDelay=1). */
function withAdaptiveDelay(client: CityClient): CityClient {
  (client as unknown as { adaptiveDelay: boolean }).adaptiveDelay = true;
  return client;
}

describe('CityClient adaptive playout delay', () => {
  it('is off unless asked for: the fixed 6-tick delay', () => {
    const { client } = makeClient();
    simulateLink(client, { hz: 60, transitMs: 1, jitterMs: 0, seconds: 5 });
    expect(client.presentationClock().playoutDelayTicks).toBe(6);
  });

  it('draws a steady link close to the newest datagram, never past it', () => {
    const { client } = makeClient();
    withAdaptiveDelay(client);
    const frames = simulateLink(client, { hz: 60, transitMs: 1, jitterMs: 0, seconds: 10 }).slice(240);
    expect(frames.filter((f) => f.presented > f.newestReceived)).toHaveLength(0);
    // The fixed 6-tick delay put it 5-6 ticks behind the server here.
    expect(median(frames.map((f) => f.presented - f.serverTick))).toBeGreaterThan(-3.5);
  });

  it('keeps a jittery link behind its newest datagram with a larger delay', () => {
    const { client } = makeClient();
    withAdaptiveDelay(client);
    const frames = simulateLink(client, { hz: 60, transitMs: 90, jitterMs: 35, seconds: 20 }).slice(600);
    expect(frames.filter((f) => f.presented > f.newestReceived)).toHaveLength(0);
    expect(client.presentationClock().playoutDelayTicks).toBeGreaterThan(2);
    expect(client.presentationClock().playoutDelayTicks).toBeLessThanOrEqual(6);
  });
});

describe('CityClient playout delay and the send cadence', () => {
  const lag = (frames: SimFrame[]) => median(frames.map((f) => f.presented - f.serverTick));

  it('presents a 60 Hz stream a tick nearer the server, never past its newest datagram', () => {
    const at30 = makeClient().client;
    const frames30 = simulateLink(at30, { hz: 60, transitMs: 1, jitterMs: 0, seconds: 5 }).slice(240);
    const at60 = makeClient().client;
    const frames60 = simulateLink(at60, { hz: 60, transitMs: 1, jitterMs: 0, seconds: 5, sendInterval: 1 }).slice(240);
    expect(at30.presentationClock().playoutDelayTicks).toBe(6);
    expect(at60.presentationClock().playoutDelayTicks).toBe(5);
    expect(at60.stats().streamIntervalTicks).toBe(1);
    expect(frames60.filter((f) => f.presented > f.newestReceived)).toHaveLength(0);
    expect(lag(frames60) - lag(frames30)).toBeGreaterThan(0.8);
  });

  it('keeps a jittery 60 Hz link behind its newest datagram', () => {
    const { client } = makeClient();
    const frames = simulateLink(client, { hz: 60, transitMs: 90, jitterMs: 35, seconds: 20, sendInterval: 1 }).slice(600);
    expect(client.presentationClock().playoutDelayTicks).toBe(5);
    expect(frames.filter((f) => f.presented > f.newestReceived)).toHaveLength(0);
  });

  it('gives a 60 Hz stream thinned to every other tick the 30 Hz delay back', () => {
    const { client } = makeClient();
    // 60 Hz for 4 s, then the rate controller sends every other tick.
    simulateLink(client, {
      hz: 60, transitMs: 30, jitterMs: 0, seconds: 8,
      sendInterval: (sentAtMs) => (sentAtMs < 5000 ? 1 : 2),
    });
    expect(client.stats().streamIntervalTicks).toBe(2);
    expect(client.presentationClock().playoutDelayTicks).toBe(6);
  });
});

/** Predictive presentation is off by default (/city?predictive=1). */
function withPredictive(client: CityClient, mode: 'data' | 'server' = 'server'): CityClient {
  (client as unknown as { predictive: string }).predictive = mode;
  return client;
}

describe('CityClient predictive presentation', () => {
  it('off (/city?predictive=0) draws no lead and ignores the horizon trailer (guard)', () => {
    const { client } = makeClient();
    withPredictive(client, 'off');
    simulateLink(client, { hz: 60, transitMs: 90, jitterMs: 35, seconds: 5, sendInterval: 1, horizonTicks: 5.4 });
    expect(client.stats().predictiveLeadTicks).toBe(0);
    expect(client.stats().predictiveHorizonTicks).toBe(5.4);
  });

  it('by default leads a 60 Hz stream to its newest data less two sends, and ignores the trailer', () => {
    const { client } = makeClient();
    const leads: number[] = [];
    const frames = simulateLink(client, {
      hz: 60, transitMs: 1, jitterMs: 0, seconds: 5, sendInterval: 1, horizonTicks: 5.4,
      onFrame: (frame) => leads.push(frame.newestReceived - (frame.presented + client.stats().predictiveLeadTicks)),
    }).slice(240);
    expect(frames.length).toBeGreaterThan(0);
    // Drawn two to three ticks behind the newest datagram, not past it.
    const behindNewest = median(leads.slice(240));
    expect(behindNewest).toBeGreaterThan(1.5);
    expect(behindNewest).toBeLessThan(3.5);
  });

  it('by default draws a stream thinned to every other tick at no lead beyond its data', () => {
    const { client } = makeClient();
    const ahead: number[] = [];
    simulateLink(client, {
      hz: 60, transitMs: 30, jitterMs: 0, seconds: 6, sendInterval: 2,
      onFrame: (frame) => ahead.push(frame.presented + client.stats().predictiveLeadTicks - frame.newestReceived),
    });
    expect(client.stats().streamIntervalTicks).toBe(2);
    expect(Math.max(...ahead.slice(360))).toBeLessThanOrEqual(0);
  });

  it('leads a fast link to the server tick', () => {
    const { client } = makeClient();
    withPredictive(client);
    const leads: number[] = [];
    const frames = simulateLink(client, {
      hz: 60, transitMs: 1, jitterMs: 0, seconds: 5, sendInterval: 1, horizonTicks: 0.06,
      onFrame: () => leads.push(client.stats().predictiveLeadTicks),
    }).slice(240);
    const behind = median(frames.map((f) => f.presented - f.serverTick));
    const lead = median(leads.slice(240));
    // Presented about 4-5 ticks behind the server, and led back to it.
    expect(behind).toBeLessThan(-3.5);
    expect(Math.abs(behind + lead)).toBeLessThan(1);
  });

  it('leads a jittery link by the server\'s horizon to the server tick, where the delay alone leaves it 8-10 behind', () => {
    const { client } = makeClient();
    withPredictive(client);
    const ahead: number[] = [];
    const frames = simulateLink(client, {
      hz: 60, transitMs: 90, jitterMs: 35, seconds: 20, sendInterval: 1, horizonTicks: 5.4,
      onFrame: (frame) => ahead.push(frame.presented + client.stats().predictiveLeadTicks - frame.serverTick),
    }).slice(600);
    expect(median(frames.map((f) => f.presented - f.serverTick))).toBeLessThan(-7);
    // Drawn at the server tick: the delay, the latency and the render
    // clock's lead over the average arrival all accounted for.
    expect(Math.abs(median(ahead.slice(600)))).toBeLessThan(1);
  });
});

describe('CityClient repair behind topology copies', () => {
  it('restates the structure, then re-applies what the copies applied after it', () => {
    const { client, resyncs } = makeClient();
    bootstrap(client);
    internals(client).handleChunks(copyDatagram(8, [{ topoSeq: 1, part: 0, parts: 1, bytes: topologyBytes(1, 10, 1, [3]) }]));
    expect(client.topology.lastSeq()).toBe(1);
    // A repair the server queued at seq 0 arrives behind the copy.
    pendingStructureBootstrap = {
      simTick: 9,
      manifestHashHex: 'a'.repeat(64),
      baselineId: 1,
      topoSeq: 0,
      structures: [{ structureId: 0, bondCount: 3, aliveBonds: new Uint8Array([0b011]) }],
      islands: [],
    } as unknown as import('./wire').BootstrapMessage;
    client.handlePacket(new Uint8Array([129]));
    expect(resyncs).toHaveLength(0);
    expect(client.topology.lastSeq()).toBe(1);
    expect(client.topology.body(bodyKey(0, 1))?.chunkSlots.length).toBe(1);
    expect(client.stats().repairsBehindCopies).toBe(1);
  });
});
