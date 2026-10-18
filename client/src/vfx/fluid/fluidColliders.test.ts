import { describe, expect, it } from 'vitest';

import type { CityManifest } from '../../city/manifest';
import { CityTopology } from '../../city/topology';
import type { TopologyMessage } from '../../city/wire';
import { atlasIndex, atlasLayout } from './fluidAtlas';
import { voxelizeStaticChunks } from './fluidColliders';

/** A 2 m cube on a 1 m post, at the origin. */
const manifest = (): CityManifest => ({
  version: 1,
  structures: [{
    structureId: 1,
    worldPosition: [0, 0, 0],
    worldRotation: [0, 0, 0, 1],
    chunks: [
      { nodeIndex: 0, centroid: [0, 0.5, 0], mass: 0, volume: 1, size: [1, 1, 1], geometry: { kind: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }, radius: 0.9, support: true },
      { nodeIndex: 1, centroid: [0, 2, 0], mass: 800, volume: 8, size: [2, 2, 2], geometry: { kind: 'cuboid', halfExtents: [1, 1, 1] }, radius: 1.7, support: false },
    ],
    bonds: [{ bondIndex: 0, node0: 0, node1: 1, centroid: [0, 1, 0], normal: [0, 1, 0], area: 1 }],
  }],
});

describe('voxelizeStaticChunks', () => {
  const layout = atlasLayout(16, 12, 16);
  const frame = { originX: -8, originY: 0, originZ: -8, sizeX: 16, sizeY: 12, sizeZ: 16 }; // 1 m cells
  const at = (out: Uint8Array, x: number, y: number, z: number) => out[atlasIndex(layout, x, y, z)];

  it('marks the ground and every static chunk, and leaves air clear', () => {
    const m = manifest();
    const topology = new CityTopology(m);
    const out = new Uint8Array(layout.width * layout.height);
    expect(voxelizeStaticChunks(topology, m, frame, layout, out)).toBe(2);
    // Ground row.
    expect(at(out, 3, 0, 3)).toBe(1);
    // The cube spans y 1..3, x/z -1..1: cells x 7..8, y 1..2, z 7..8 (and the boundary at 3 → row 3).
    expect(at(out, 8, 2, 8)).toBe(1);
    expect(at(out, 7, 1, 7)).toBe(1);
    // Air beside it and above it.
    expect(at(out, 12, 2, 8)).toBe(0);
    expect(at(out, 8, 6, 8)).toBe(0);
  });

  it('ignores an island that is moving, and counts it again once settled', () => {
    const m = manifest();
    const topology = new CityTopology(m);
    const promote: TopologyMessage = {
      topoSeq: 1, simTick: 5, wakes: [], settled: [],
      batches: [{
        structureId: 1, brokenBondIndices: [0], retiredIslandIds: [], migrations: [],
        promotions: [{ structureId: 1, islandId: 1, nodes: [1], position: [5, 2, 0], rotation: [0, 0, 0, 1], linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] }],
      }],
    };
    topology.apply(promote);
    const out = new Uint8Array(layout.width * layout.height);
    expect(voxelizeStaticChunks(topology, m, frame, layout, out)).toBe(1);
    expect(at(out, 13, 2, 8)).toBe(0);
    topology.apply({ topoSeq: 2, simTick: 50, wakes: [], batches: [], settled: [{ structureId: 1, islandId: 1, position: [5, 2, 0], rotation: [0, 0, 0, 1] }] });
    expect(voxelizeStaticChunks(topology, m, frame, layout, out)).toBe(2);
    expect(at(out, 13, 2, 8)).toBe(1);
  });

  it('skips chunks outside the brick', () => {
    const m = manifest();
    const topology = new CityTopology(m);
    const out = new Uint8Array(layout.width * layout.height);
    expect(voxelizeStaticChunks(topology, m, { ...frame, originX: 100 }, layout, out)).toBe(0);
  });
});
