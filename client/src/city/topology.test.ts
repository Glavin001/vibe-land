// Ledger tests: promotion re-parenting math, bond bitsets, bootstrap rebuild,
// and sequence-gap detection.

import { describe, expect, it } from 'vitest';

import type { CityManifest } from './manifest';
import { CityTopology, bodyKey } from './topology';
import type { TopologyMessage } from './wire';

const manifest = (): CityManifest => ({
  version: 1,
  structures: [
    {
      structureId: 0,
      worldPosition: [10, 0, 0],
      worldRotation: [0, 0, 0, 1],
      chunks: [0, 1, 2].map((node) => ({
        nodeIndex: node,
        centroid: [0, node + 0.5, 0],
        mass: node === 0 ? 0 : 10,
        volume: 1,
        size: [1, 1, 1],
        geometry: { kind: 'Cuboid', halfExtents: [0.5, 0.5, 0.5] },
        radius: 0.87,
        support: node === 0,
      })),
      bonds: [
        { bondIndex: 0, node0: 0, node1: 1, centroid: [0, 1, 0], normal: [0, 1, 0], area: 1 },
        { bondIndex: 1, node0: 1, node1: 2, centroid: [0, 2, 0], normal: [0, 1, 0], area: 1 },
      ],
    },
  ],
});

const fractureMessage = (topoSeq: number): TopologyMessage => ({
  topoSeq,
  simTick: 10,
  batches: [
    {
      structureId: 0,
      brokenBondIndices: [1],
      promotions: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          // The adapter re-centres a split child on its centre of mass, so a
          // promotion pose is the island COM in world: structure origin
          // (10,0,0) + the single member's rest centroid (0,2.5,0).
          position: [10, 2.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [1, 0, 0],
          angularVelocity: [0, 0, 0],
        },
      ],
      retiredIslandIds: [],
    },
  ],
  settled: [],
  wakes: [],
});

describe('CityTopology', () => {
  it('starts with every chunk on the intact support body', () => {
    const topology = new CityTopology(manifest());
    expect(topology.chunkCount).toBe(3);
    const pose = topology.chunkWorldPose(2);
    expect(pose.position).toEqual([10, 2.5, 0]); // world offset + rest centroid
  });

  it('promotion re-parents chunks with correct local offsets', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(fractureMessage(1))).toBe(true);
    const key = bodyKey(0, 1);
    const body = topology.body(key);
    expect(body).toBeDefined();
    expect(body!.chunkSlots).toEqual([2]);
    // World pose unchanged at the promotion instant.
    const before = topology.chunkWorldPose(2);
    expect(before.position[1]).toBeCloseTo(2.5, 5);
    // Moving the body moves the chunk rigidly.
    topology.updateBodyPose(key, [10, 1.5, 0], [0, 0, 0, 1]);
    const after = topology.chunkWorldPose(2);
    expect(after.position[1]).toBeCloseTo(1.5, 5);
    // The support body keeps the remaining chunks.
    const support = topology.body(bodyKey(0, 0));
    expect(support!.chunkSlots).toHaveLength(2);
    expect(topology.stats().brokenBonds).toBe(1);
  });

  // The bug this pins: offsets used to be derived from `chunkWorldPose(slot)`
  // at the promotion instant, so they silently absorbed however wrong this
  // client's view was. Topology is reliable and immediate; the parent's
  // kinematic poses are unreliable, rate limited and interest culled, and a
  // chunk re-parented by physics without a promotion is not tracked at all.
  // Islands are rigid, so any error was frozen in for the match — chunks ended
  // up rendering metres under the floor while the server had every body
  // resting at y ≈ 0.
  it('derives island offsets independently of the client\'s prior view', () => {
    const clean = new CityTopology(manifest());
    clean.apply(fractureMessage(1));
    const expected = clean.chunkWorldPose(2).position;

    // Same promotion, but this client's view of the parent is badly stale.
    const stale = new CityTopology(manifest());
    stale.updateBodyPose(bodyKey(0, 0), [999, -500, 999], [0, 0, 0, 1]);
    stale.apply(fractureMessage(1));

    expect(stale.chunkWorldPose(2).position[0]).toBeCloseTo(expected[0], 5);
    expect(stale.chunkWorldPose(2).position[1]).toBeCloseTo(expected[1], 5);
    expect(stale.chunkWorldPose(2).position[2]).toBeCloseTo(expected[2], 5);
  });

  it('weights an island centre of mass by chunk mass', () => {
    const topology = new CityTopology(manifest());
    // Nodes 1 and 2 (mass 10 each, rest y 1.5 and 2.5) -> COM y = 2.0.
    topology.apply({
      topoSeq: 1,
      simTick: 10,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0],
          promotions: [
            {
              structureId: 0,
              islandId: 1,
              nodes: [1, 2],
              position: [10, 2, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
        },
      ],
      settled: [],
      wakes: [],
    });
    // Both chunks keep their rest separation and straddle the body origin.
    expect(topology.chunkWorldPose(1).position[1]).toBeCloseTo(1.5, 5);
    expect(topology.chunkWorldPose(2).position[1]).toBeCloseTo(2.5, 5);
  });

  // The bug this pins: an island body's chunks were re-offset only when
  // GAINED, never when LOST. A body's wire pose is its centre of mass
  // (com_world_position in physx-bridge/src/destruction.cc), so shedding a
  // member moves that pose even though the rigid body itself did not -- and
  // leaving the remaining chunks' offsets keyed on the old centre of mass
  // displaced them by exactly that delta the instant a further split landed.
  // Reported as "the building translates as it fractures".
  it('re-offsets a body\'s surviving chunks when it sheds a member', () => {
    const topology = new CityTopology(manifest());
    // Stage 1: break bond 0, promoting nodes 1 and 2 (equal mass) together.
    // COM y = 2.0, so node 1 (rest y 1.5) sits at local offset -0.5 within
    // this body.
    topology.apply({
      topoSeq: 1,
      simTick: 10,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [0],
          promotions: [
            {
              structureId: 0,
              islandId: 1,
              nodes: [1, 2],
              position: [10, 2, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
        },
      ],
      settled: [],
      wakes: [],
    });
    const before = topology.body(bodyKey(0, 1))!;
    expect(before.chunkSlots).toEqual([1, 2]);

    // Stage 2: bond 1 (node 1 - node 2) breaks, and node 2 secedes into a new
    // island. Body 1 keeps only node 1. The server now reports body 1's pose
    // as node 1's own rest centroid (its centre of mass with one member),
    // not the stale two-node COM.
    topology.apply({
      topoSeq: 2,
      simTick: 20,
      batches: [
        {
          structureId: 0,
          brokenBondIndices: [1],
          promotions: [
            {
              structureId: 0,
              islandId: 2,
              nodes: [2],
              position: [10, 2.5, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            },
          ],
          retiredIslandIds: [],
        },
      ],
      settled: [],
      wakes: [],
    });

    const shrunk = topology.body(bodyKey(0, 1))!;
    expect(shrunk.chunkSlots).toEqual([1]);

    // If body 1 now reports its pose as node 1's rest centroid (origin +
    // (0, 1.5, 0)) -- the only physically consistent pose for a one-member
    // body -- node 1 must land exactly on its rest position. Before the fix
    // this failed by 0.5 m: the stale offset (-0.5) was still applied on top
    // of the new pose.
    topology.updateBodyPose(bodyKey(0, 1), [10, 1.5, 0], [0, 0, 0, 1]);
    const pose = topology.chunkWorldPose(1).position;
    expect(pose[0]).toBeCloseTo(10, 5);
    expect(pose[1]).toBeCloseTo(1.5, 5);
    expect(pose[2]).toBeCloseTo(0, 5);
  });

  it('bootstrap and live promotion agree chunk for chunk', () => {
    // A late joiner rebuilding from bootstrap must land on the same world
    // poses as a client that watched the collapse happen.
    const live = new CityTopology(manifest());
    live.apply(fractureMessage(1));
    live.updateBodyPose(bodyKey(0, 1), [10, 0.5, 0], [0, 0, 0, 1]);

    const late = new CityTopology(manifest());
    late.applyBootstrap({
      simTick: 99,
      manifestHashHex: 'aa',
      baselineId: 4,
      topoSeq: 41,
      structures: [{ structureId: 0, bondCount: 2, aliveBonds: new Uint8Array([0b01]) }],
      islands: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          position: [10, 0.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          settled: true,
        },
      ],
    });

    const a = live.chunkWorldPose(2).position;
    const b = late.chunkWorldPose(2).position;
    expect(b[0]).toBeCloseTo(a[0], 5);
    expect(b[1]).toBeCloseTo(a[1], 5);
    expect(b[2]).toBeCloseTo(a[2], 5);
  });

  it('detects topology sequence gaps and flags resync', () => {
    const topology = new CityTopology(manifest());
    expect(topology.apply(fractureMessage(1))).toBe(true);
    expect(topology.apply(fractureMessage(3))).toBe(false);
    expect(topology.needsResync).toBe(true);
    expect(topology.stats().topoSeqGaps).toBe(1);
    // Duplicates of already-applied sequences are fine.
    expect(topology.apply(fractureMessage(1))).toBe(true);
  });

  it('rebuilds from bootstrap including bitsets and islands', () => {
    const topology = new CityTopology(manifest());
    topology.apply(fractureMessage(1));
    topology.applyBootstrap({
      simTick: 99,
      manifestHashHex: 'aa',
      baselineId: 4,
      topoSeq: 41,
      structures: [
        { structureId: 0, bondCount: 2, aliveBonds: new Uint8Array([0b01]) }, // bond 1 broken
      ],
      islands: [
        {
          structureId: 0,
          islandId: 1,
          nodes: [2],
          // COM frame again: the island has fallen 2 m from its rest COM.
          position: [10, 0.5, 0],
          rotation: [0, 0, 0, 1],
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          settled: true,
        },
      ],
    });
    expect(topology.lastSeq()).toBe(41);
    expect(topology.needsResync).toBe(false);
    expect(topology.stats().brokenBonds).toBe(1);
    const body = topology.body(bodyKey(0, 1));
    expect(body!.settled).toBe(true);
    expect(topology.chunkWorldPose(2).position[1]).toBeCloseTo(0.5, 5); // 2.5 - 2 fell
  });
});
