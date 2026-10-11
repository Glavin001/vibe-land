import { describe, expect, it } from 'vitest';

import type { CityManifest } from '../city/manifest';
import { CityTopology } from '../city/topology';
import type { TopologyMessage } from '../city/wire';
import { CityVehicleColliders, intactCityShapes, type StaticShapeSink } from './cityColliders';

// A tower of three chunks at (10, 0, 0), turned 90 degrees about y: two
// cuboids, then a hull on top.
const s = Math.SQRT1_2;
const manifest = (): CityManifest => ({
  version: 1,
  structures: [{
    structureId: 0,
    worldPosition: [10, 0, 0],
    worldRotation: [0, s, 0, s],
    chunks: [0, 1, 2].map((node) => ({
      nodeIndex: node,
      centroid: [1, node + 0.5, 0] as [number, number, number],
      mass: node === 0 ? 0 : 10,
      volume: 1,
      size: [1, 1, 1] as [number, number, number],
      geometry: node < 2
        ? { kind: 'Cuboid' as const, halfExtents: [0.5, 0.5, 0.25] as [number, number, number] }
        : { kind: 'ConvexHull' as const, points: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5] },
      radius: 0.87,
      support: node === 0,
    })),
    bonds: [
      { bondIndex: 0, node0: 0, node1: 1, centroid: [1, 1, 0], normal: [0, 1, 0], area: 1 },
      { bondIndex: 1, node0: 1, node1: 2, centroid: [1, 2, 0], normal: [0, 1, 0], area: 1 },
    ],
  }],
});

const sink = () => {
  const shapes = new Map<number, { pose: number[]; count: number; data: number[] }>();
  const calls = { set: 0, remove: 0 };
  const s: StaticShapeSink = {
    setStaticShapes(keys, poses, counts, data) {
      calls.set += 1;
      let at = 0;
      keys.forEach((key, i) => {
        const take = counts[i] === 0 ? 3 : counts[i] * 3;
        shapes.set(key, { pose: Array.from(poses.subarray(i * 7, i * 7 + 7)), count: counts[i], data: Array.from(data.subarray(at, at + take)) });
        at += take;
      });
      return keys.length;
    },
    removeStaticShapes(keys) {
      calls.remove += 1;
      for (const key of keys) shapes.delete(key);
    },
  };
  return { s, shapes, calls };
};

const breakTop = (topoSeq: number): TopologyMessage => ({
  topoSeq, simTick: 10, settled: [], wakes: [],
  batches: [{ structureId: 0, brokenBondIndices: [1], retiredIslandIds: [], migrations: [],
    promotions: [{ structureId: 0, islandId: 1, nodes: [2], position: [10, 2.5, 0], rotation: [0, 0, 0, 1], linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] }] }],
});

describe('city colliders for vehicle prediction', () => {
  // The server's physics collides a car with every standing chunk as its own
  // shape, placed by its structure: so must the driven car's prediction.
  it('places each standing chunk as its own shape, where its structure puts it', () => {
    const { s: out, shapes } = sink();
    const topology = new CityTopology(manifest());
    const colliders = new CityVehicleColliders(out, manifest(), topology);
    colliders.sync();
    expect(colliders.count).toBe(3);
    // Centroid (1, 0.5, 0) turned 90 degrees about y lands at (0, 0.5, -1).
    const [x, y, z] = shapes.get(0)!.pose;
    expect([x, y, z].map((v) => +v.toFixed(5))).toEqual([10, 0.5, -1]);
    expect(shapes.get(0)!.pose.slice(3).map((v) => +v.toFixed(5))).toEqual([0, +s.toFixed(5), 0, +s.toFixed(5)]);
    expect(shapes.get(1)).toMatchObject({ count: 0, data: [0.5, 0.5, 0.25] });
    expect(shapes.get(2)!.count).toBe(4);
  });

  // A chunk that breaks loose is moving debris, not a wall: it stops
  // colliding, and only it is touched.
  it('drops a chunk when it breaks loose, touching only the chunks that changed', () => {
    const { s: out, shapes, calls } = sink();
    const topology = new CityTopology(manifest());
    const colliders = new CityVehicleColliders(out, manifest(), topology);
    colliders.sync();
    colliders.sync();
    expect(calls).toEqual({ set: 1, remove: 0 });
    topology.apply(breakTop(1));
    colliders.sync();
    expect([...shapes.keys()]).toEqual([0, 1]);
    expect(colliders.count).toBe(2);
    expect(calls.remove).toBe(1);
    // A reset stands everything up again.
    topology.reset();
    colliders.sync();
    expect([...shapes.keys()].sort()).toEqual([0, 1, 2]);
  });

  it('packs an intact city for a replay the same way', () => {
    const packed = intactCityShapes(manifest());
    expect(Array.from(packed.counts)).toEqual([0, 0, 4]);
    expect(packed.data.length).toBe(3 + 3 + 12);
  });
});
