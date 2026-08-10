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
          position: [10, 0, 0], // island body frame = structure frame at split
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
    topology.updateBodyPose(key, [10, -1, 0], [0, 0, 0, 1]);
    const after = topology.chunkWorldPose(2);
    expect(after.position[1]).toBeCloseTo(1.5, 5);
    // The support body keeps the remaining chunks.
    const support = topology.body(bodyKey(0, 0));
    expect(support!.chunkSlots).toHaveLength(2);
    expect(topology.stats().brokenBonds).toBe(1);
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
          position: [10, -2, 0],
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
