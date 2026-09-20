import { beforeEach, describe, expect, it } from 'vitest';

import {
  DustSourceQueue,
  extractDustSources,
  type DustExtractContext,
  type DustSource,
} from './destructionEvents';
import type { CityManifest, ManifestStructure } from './manifest';
import { bodyKey, CityTopology } from './topology';
import type { TopologyMessage } from './wire';

/** A four-chunk column joined by three bonds, sited anywhere with any yaw. */
function column(structureId: number, at: [number, number, number], yaw = 0): ManifestStructure {
  const half = yaw / 2;
  return {
    structureId,
    worldPosition: at,
    worldRotation: [0, Math.sin(half), 0, Math.cos(half)],
    chunks: [0, 1, 2, 3].map((node) => ({
      nodeIndex: node,
      centroid: [1, node + 0.5, 0],
      mass: node === 0 ? 0 : 500,
      volume: 1,
      size: [1, 1, 1],
      geometry: { kind: 'cuboid', halfExtents: [0.5, 0.5, 0.5] },
      radius: 0.87,
      support: node === 0,
    })),
    bonds: [0, 1, 2].map((i) => ({
      bondIndex: i,
      node0: i,
      node1: i + 1,
      centroid: [1, i + 1, 0],
      normal: [0, 1, 0],
      area: 0.5,
    })),
  };
}

function context(manifest: CityManifest, over: Partial<DustExtractContext> = {}) {
  const topology = new CityTopology(manifest);
  const drawn = new Map<number, Float32Array>();
  const speeds = new Map<number, number>();
  const ctx: DustExtractContext = {
    manifest,
    topology,
    structureById: new Map(manifest.structures.map((s) => [s.structureId, s])),
    drawnPoseInto: (slot, out, at) => {
      const p = drawn.get(slot);
      if (!p) return false;
      out.set(p, at);
      return true;
    },
    presentedSpeed: (key) => speeds.get(key) ?? 0,
    ...over,
  };
  return { ctx, topology, drawn, speeds };
}

const message = (over: Partial<TopologyMessage>): TopologyMessage => ({
  topoSeq: 1, simTick: 100, batches: [], settled: [], wakes: [], ...over,
});

const fracture = (structureId: number, bonds: number[], promotions: TopologyMessage['batches'][number]['promotions'] = []) => ({
  structureId, brokenBondIndices: bonds, promotions, retiredIslandIds: [], migrations: [],
});

function drained(queue: DustSourceQueue): DustSource[] {
  const out: DustSource[] = [];
  queue.drain((s) => out.push({ ...s }));
  return out;
}

describe('extractDustSources', () => {
  let queue: DustSourceQueue;
  beforeEach(() => {
    queue = new DustSourceQueue();
  });

  it('puts a fracture where the bond is, through the structure pose', () => {
    // Yaw 90°: structure-local +x becomes world -z.
    const manifest: CityManifest = { version: 1, structures: [column(7, [10, 0, 5], Math.PI / 2)] };
    const { ctx, topology } = context(manifest);
    const msg = message({ batches: [fracture(7, [1])] });
    topology.apply(msg);
    expect(extractDustSources(msg, ctx, queue, 1234)).toBe(1);
    const [s] = drained(queue);
    expect(s.kind).toBe('fracture');
    expect(s.structureId).toBe(7);
    expect(s.simTick).toBe(100);
    expect(s.x).toBeCloseTo(10, 4);
    expect(s.y).toBeCloseTo(2, 4);
    expect(s.z).toBeCloseTo(4, 4);
    expect(s.magnitude).toBeCloseTo(5); // 10 units per m² × 0.5 m²
    expect(s.count).toBe(1);
    expect([s.vx, s.vy, s.vz]).toEqual([0, 0, 0]);
    expect(s.ny).toBeCloseTo(1);
    expect(s.atMs).toBe(1234);
  });

  it('merges bonds in one cell and keeps distant ones apart, weighting by area', () => {
    const near = column(1, [0, 0, 0]);
    near.bonds![1].area = 1.5; // bonds 0,1 at y=1,2 share a 4 m cell
    const far = column(2, [100, 0, 0]);
    const manifest: CityManifest = { version: 1, structures: [near, far] };
    const { ctx, topology } = context(manifest);
    const msg = message({ batches: [fracture(1, [0, 1]), fracture(2, [2])] });
    topology.apply(msg);
    expect(extractDustSources(msg, ctx, queue, 0)).toBe(2);
    const sources = drained(queue);
    const merged = sources.find((s) => s.structureId === 1)!;
    expect(merged.count).toBe(2);
    expect(merged.magnitude).toBeCloseTo(20);
    // Area-weighted: (1·0.5 + 2·1.5) / 2 = 1.75
    expect(merged.y).toBeCloseTo(1.75);
    expect(sources.find((s) => s.structureId === 2)!.x).toBeCloseTo(101);
  });

  it('prefers the drawn pose of a promoted chunk over the ledger', () => {
    const manifest: CityManifest = { version: 1, structures: [column(1, [0, 0, 0])] };
    const { ctx, topology, drawn } = context(manifest);
    const promotion = {
      structureId: 1, islandId: 3, nodes: [2, 3], position: [1, 3, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      linearVelocity: [0, -4, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
    };
    const msg = message({ batches: [fracture(1, [1], [promotion])] });
    // Chunk 2 (node0 of bond 1... no: bond 1 joins nodes 1 and 2) is drawn 5 m east of rest.
    drawn.set(topology.slotOf(1, 1), new Float32Array([6, 1.5, 0, 0, 0, 0, 1]));
    topology.apply(msg);
    extractDustSources(msg, ctx, queue, 0);
    const sources = drained(queue);
    const frac = sources.find((s) => s.kind === 'fracture')!;
    expect(frac.x).toBeCloseTo(6);
    // The bond touches a promoted node, so it takes the island's velocity.
    expect(frac.vy).toBeCloseTo(-4);
    // A moving island also sheds.
    const shed = sources.find((s) => s.kind === 'shed')!;
    expect(shed.magnitude).toBeCloseTo(1000 / 500);
    expect(shed.y).toBe(3);
  });

  it('folds a slow, light island into its fracture instead of puffing twice', () => {
    const manifest: CityManifest = { version: 1, structures: [column(1, [0, 0, 0])] };
    const { ctx, topology } = context(manifest);
    const promotion = {
      structureId: 1, islandId: 3, nodes: [3], position: [1, 3.5, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      linearVelocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
    };
    const msg = message({ batches: [fracture(1, [2], [promotion])] });
    topology.apply(msg);
    expect(extractDustSources(msg, ctx, queue, 0)).toBe(1);
    const [s] = drained(queue);
    expect(s.kind).toBe('fracture');
    expect(s.magnitude).toBeCloseTo(5 + 0.25 * (500 / 500));
  });

  it('raises an impact where a fast island came to rest, and none for a crawl', () => {
    const manifest: CityManifest = { version: 1, structures: [column(1, [0, 0, 0])] };
    const { ctx, topology, speeds } = context(manifest);
    const promotion = {
      structureId: 1, islandId: 3, nodes: [2, 3], position: [1, 3, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      linearVelocity: [0, -8, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number],
    };
    topology.apply(message({ batches: [fracture(1, [1], [promotion])] }));
    const key = bodyKey(1, 3);
    speeds.set(key, 8);
    const settle = message({
      simTick: 130,
      settled: [{ structureId: 1, islandId: 3, position: [4, 1.2, 0], rotation: [0, 0, 0, 1] }],
    });
    topology.apply(settle);
    expect(extractDustSources(settle, ctx, queue, 0)).toBe(1);
    const [s] = drained(queue);
    expect(s.kind).toBe('impact');
    expect(s.magnitude).toBeCloseTo((0.5 * 1000 * 64) / 5000);
    expect(s.x).toBeCloseTo(4);
    expect(s.y).toBeCloseTo(0.3);
    speeds.set(key, 1);
    expect(extractDustSources(settle, ctx, queue, 0)).toBe(0);
  });

  it('caps sources per message by magnitude and numbers them deterministically', () => {
    // Forty structures, each breaking one bond: forty sources.
    const structures = Array.from({ length: 40 }, (_, i) => {
      const s = column(i, [i * 10, 0, 0]);
      s.bonds![0].area = 0.1 * (i + 1);
      return s;
    });
    const manifest: CityManifest = { version: 1, structures };
    const { ctx, topology } = context(manifest);
    const msg = message({ batches: structures.map((s) => fracture(s.structureId, [0])) });
    topology.apply(msg);
    expect(extractDustSources(msg, ctx, queue, 0, { maxSourcesPerMessage: 8 })).toBe(8);
    const first = drained(queue);
    expect(first.map((s) => s.structureId).sort((a, b) => a - b)).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
    expect(first[0].magnitude).toBeGreaterThanOrEqual(first[7].magnitude);
    expect(first.every((s) => s.ordinal === 0)).toBe(true);
    extractDustSources(msg, ctx, queue, 0, { maxSourcesPerMessage: 8 });
    expect(drained(queue)).toEqual(first);
  });

  it('numbers several sources of one structure by cell, not arrival order', () => {
    const tall = column(1, [0, 0, 0]);
    tall.chunks[3].centroid = [1, 30, 0];
    tall.bonds![2].centroid = [1, 29, 0];
    const manifest: CityManifest = { version: 1, structures: [tall] };
    const { ctx, topology } = context(manifest);
    const msg = message({ batches: [fracture(1, [0, 2])] });
    topology.apply(msg);
    extractDustSources(msg, ctx, queue, 0);
    const sources = drained(queue).sort((a, b) => a.ordinal - b.ordinal);
    expect(sources.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(sources[0].y).toBeLessThan(sources[1].y);
  });
});

describe('DustSourceQueue', () => {
  it('drops the newest when full and keeps count', () => {
    const q = new DustSourceQueue(2);
    const s = (x: number): DustSource => ({
      kind: 'fracture', structureId: 0, simTick: 0, ordinal: 0, x, y: 0, z: 0, nx: 0, ny: 0, nz: 0,
      vx: 0, vy: 0, vz: 0, magnitude: 1, count: 1, material: 0, atMs: 0,
    });
    expect(q.push(s(1))).toBe(true);
    expect(q.push(s(2))).toBe(true);
    expect(q.push(s(3))).toBe(false);
    expect(q.dropped).toBe(1);
    const seen: number[] = [];
    expect(q.drain((v) => seen.push(v.x))).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(q.size()).toBe(0);
    expect(q.push(s(4))).toBe(true);
  });
});
