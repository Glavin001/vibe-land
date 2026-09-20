import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { CityManifest } from '../city/manifest';
import { CityTopology } from '../city/topology';
import { DustClearance } from './dustClearance';
import { DustOccupancy, OCC_CELL_M, OCC_SIZE_X, OCC_SIZE_Y } from './dustOccupancy';

const city = (): CityManifest => ({
  version: 1,
  structures: [{
    structureId: 1,
    worldPosition: [0, 0, 0],
    worldRotation: [0, 0, 0, 1],
    chunks: [
      { nodeIndex: 0, centroid: [0, 0.25, 0], mass: 0, volume: 1, size: [4, 0.5, 4], geometry: { kind: 'cuboid', halfExtents: [2, 0.25, 2] }, radius: 3, support: true },
      { nodeIndex: 1, centroid: [10, 3, 0], mass: 5000, volume: 24, size: [1, 6, 8], geometry: { kind: 'cuboid', halfExtents: [0.5, 3, 4] }, radius: 5, support: false },
    ],
    bonds: [{ bondIndex: 0, node0: 0, node1: 1, centroid: [5, 0.5, 0], normal: [0, 1, 0], area: 8 }],
  }],
});

function texel(occ: DustOccupancy, x: number, y: number, z: number): number {
  const ix = Math.floor((x - occ.origin.x) / OCC_CELL_M);
  const iy = Math.floor((y - occ.origin.y) / OCC_CELL_M);
  const iz = Math.floor((z - occ.origin.z) / OCC_CELL_M);
  return (occ.texture.image.data as Uint8Array)[(iz * OCC_SIZE_Y + iy) * OCC_SIZE_X + ix];
}

describe('DustOccupancy', () => {
  it('marks the wall and the ground around the camera and leaves air clear', () => {
    const m = city();
    const topology = new CityTopology(m);
    const occ = new DustOccupancy(new DustClearance(topology, m));
    expect(occ.update(new THREE.Vector3(0, 2, 0), 0, 1000)).toBe(true);
    expect(texel(occ, 10, 3, 0)).toBe(255); // wall
    expect(texel(occ, 5, 3, 0)).toBe(0); // air between
    expect(texel(occ, 5, -0.2, 0)).toBe(255); // ground
    expect(texel(occ, 0, 0.1, 0)).toBe(255); // slab
    expect(texel(occ, 30, 20, 30)).toBe(0);
  });

  it('rebuilds only when moved or changed, and drops a wall that fell', () => {
    const m = city();
    const topology = new CityTopology(m);
    const occ = new DustOccupancy(new DustClearance(topology, m));
    occ.update(new THREE.Vector3(0, 2, 0), 0, 1000);
    expect(occ.update(new THREE.Vector3(1, 2, 0), 0, 1100)).toBe(false);
    expect(occ.update(new THREE.Vector3(1, 2, 0), 1, 1100)).toBe(false); // changed but too soon
    topology.apply({
      topoSeq: 1, simTick: 1, wakes: [], settled: [],
      batches: [{ structureId: 1, brokenBondIndices: [0], retiredIslandIds: [], migrations: [],
        promotions: [{ structureId: 1, islandId: 1, nodes: [1], position: [10, 3, 0], rotation: [0, 0, 0, 1], linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] }] }],
    });
    expect(occ.update(new THREE.Vector3(1, 2, 0), 1, 2000)).toBe(true);
    expect(texel(occ, 10, 3, 0)).toBe(0);
    expect(occ.update(new THREE.Vector3(40, 2, 0), 1, 2001)).toBe(true); // moved far
  });
});
