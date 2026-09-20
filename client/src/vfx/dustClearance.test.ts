import { describe, expect, it } from 'vitest';

import type { CityManifest } from '../city/manifest';
import { CityTopology } from '../city/topology';
import { CLEARANCE_MAX_M, DustClearance } from './dustClearance';
import { DEFAULT_DUST_EVAL_TUNING, DustPalette, DustParcelStore, DustShape, evalParcel, newDustEval } from './dustParcelStore';

/** A room: floor slab at y 0..0.5, a wall at x 5..6 (y 0..6, z -4..4), and a ceiling at y 6..6.5. */
const room = (): CityManifest => ({
  version: 1,
  structures: [{
    structureId: 1,
    worldPosition: [0, 0, 0],
    worldRotation: [0, 0, 0, 1],
    chunks: [
      { nodeIndex: 0, centroid: [0, 0.25, 0], mass: 0, volume: 1, size: [12, 0.5, 12], geometry: { kind: 'cuboid', halfExtents: [6, 0.25, 6] }, radius: 8, support: true },
      { nodeIndex: 1, centroid: [5.5, 3, 0], mass: 5000, volume: 24, size: [1, 6, 8], geometry: { kind: 'cuboid', halfExtents: [0.5, 3, 4] }, radius: 5, support: false },
      { nodeIndex: 2, centroid: [0, 6.25, 0], mass: 5000, volume: 36, size: [12, 0.5, 12], geometry: { kind: 'cuboid', halfExtents: [6, 0.25, 6] }, radius: 8, support: false },
    ],
    bonds: [
      { bondIndex: 0, node0: 0, node1: 1, centroid: [5.5, 0.5, 0], normal: [0, 1, 0], area: 8 },
      { bondIndex: 1, node0: 1, node1: 2, centroid: [5.5, 6, 0], normal: [0, 1, 0], area: 8 },
    ],
  }],
});

describe('DustClearance', () => {
  it('measures the room around a point', () => {
    const m = room();
    const c = new DustClearance(new CityTopology(m), m);
    const out = new Float32Array(6);
    c.clearanceAt(2, 2, 0, out);
    expect(out[1]).toBeCloseTo(3); // wall at x = 5
    expect(out[0]).toBe(CLEARANCE_MAX_M); // nothing on −x
    expect(out[2]).toBeCloseTo(1.5); // floor top at 0.5
    expect(out[3]).toBeCloseTo(4); // ceiling at 6
    expect(out[4]).toBe(CLEARANCE_MAX_M);
  });

  it('reports no room at all inside a standing chunk', () => {
    const m = room();
    const c = new DustClearance(new CityTopology(m), m);
    const out = new Float32Array(6);
    c.clearanceAt(5.5, 3, 0, out); // in the wall
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('ignores a chunk that no longer stands', () => {
    const m = room();
    const topology = new CityTopology(m);
    const c = new DustClearance(topology, m);
    topology.apply({
      topoSeq: 1, simTick: 1, wakes: [], settled: [],
      batches: [{ structureId: 1, brokenBondIndices: [0, 1], retiredIslandIds: [], migrations: [],
        promotions: [{ structureId: 1, islandId: 1, nodes: [1], position: [5.5, 3, 0], rotation: [0, 0, 0, 1], linearVelocity: [1, 0, 0], angularVelocity: [0, 0, 0] }] }],
    });
    const out = new Float32Array(6);
    c.clearanceAt(2, 2, 0, out);
    expect(out[1]).toBe(CLEARANCE_MAX_M);
  });

  it('keeps a parcel inside its room as it grows and drifts', () => {
    const m = room();
    const c = new DustClearance(new CityTopology(m), m);
    const clearance = new Float32Array(6);
    c.clearanceAt(2, 2, 0, clearance);
    const store = new DustParcelStore(4);
    const slot = store.spawn({
      bornMs: 0, x: 2, y: 2, z: 0, vx: 4, vy: 0, vz: 0, radius0: 3, intensity: 1, seed: 1,
      shape: DustShape.Fracture, palette: DustPalette.Concrete, clearance,
    });
    const e = newDustEval();
    evalParcel(store, slot, 8000, 0, 0, DEFAULT_DUST_EVAL_TUNING, e);
    // Pushed +x toward the wall at x = 5: never past it.
    expect(e.cx + e.sx / 2).toBeLessThanOrEqual(5 + 1e-4);
    // Ceiling at 6, floor at 0.5.
    expect(e.cy + e.sy / 2).toBeLessThanOrEqual(6 + 1e-4);
    expect(e.cy - e.sy / 2).toBeGreaterThanOrEqual(0.5 - 1e-4);
    // Open on −x: the cloud is still big.
    expect(e.sz).toBeGreaterThan(6);
  });
});
