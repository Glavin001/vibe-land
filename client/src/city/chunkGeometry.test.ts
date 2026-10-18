// Shape selection for chunk rendering: which chunks become hulls, which fall
// back to boxes, and when two hulls are the same geometry.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  MIN_HULL_POINTS,
  boxScale,
  buildBoxGeometry,
  buildHullGeometry,
  chunkShape,
  hullKey,
} from './chunkGeometry';
import type { ManifestChunk } from './manifest';

const chunk = (overrides: Partial<ManifestChunk> = {}): ManifestChunk =>
  ({
    nodeIndex: 0,
    centroid: [0, 0, 0],
    mass: 10,
    volume: 1,
    size: [2, 3, 4],
    geometry: { kind: 'Cuboid', halfExtents: [1, 1.5, 2] },
    radius: 2.7,
    support: false,
    ...overrides,
  }) as ManifestChunk;

// A tetrahedron: the smallest point set that encloses volume.
const TETRA = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('chunkShape', () => {
  it('renders a cuboid chunk as a scaled box', () => {
    const shape = chunkShape(chunk());
    expect(shape.kind).toBe('box');
    expect(shape.kind === 'box' && shape.scale).toEqual([2, 3, 4]);
  });

  it('renders a convex hull chunk as a hull', () => {
    const shape = chunkShape(chunk({ geometry: { kind: 'ConvexHull', points: TETRA } }));
    expect(shape.kind).toBe('hull');
    expect(shape.kind === 'hull' && Array.from(shape.points)).toEqual(TETRA);
  });

  it('accepts the lowercase spelling the server may emit', () => {
    const shape = chunkShape(chunk({ geometry: { kind: 'convexHull', points: TETRA } }));
    expect(shape.kind).toBe('hull');
  });

  // A malformed chunk should cost one chunk's fidelity, not the whole mesh:
  // throwing here would abort the build and leave the city invisible, which
  // is a far worse failure than one piece drawn as its bounding box.
  it.each([
    ['too few points', [0, 0, 0, 1, 0, 0, 0, 1, 0]],
    ['a truncated triple', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],
    ['a non-finite coordinate', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, Number.NaN]],
    ['no points at all', []],
  ])('falls back to a box for %s', (_label, points) => {
    const shape = chunkShape(chunk({ geometry: { kind: 'ConvexHull', points } }));
    expect(shape.kind).toBe('box');
  });

  it('requires four points to enclose a volume', () => {
    expect(MIN_HULL_POINTS).toBe(4);
  });
});

describe('boxScale', () => {
  it('floors degenerate extents so a chunk cannot collapse', () => {
    expect(boxScale(chunk({ size: [0, 0, 0] }))).toEqual([0.05, 0.05, 0.05]);
  });

  it('derives extents from cuboid half-extents when size is missing', () => {
    const scale = boxScale(
      chunk({ size: undefined as unknown as [number, number, number] }),
    );
    expect(scale).toEqual([2, 3, 4]);
  });
});

describe('hullKey', () => {
  // The city stamps one building pack many times, so the same shard recurs
  // once per instance. Sharing geometry across them is the difference between
  // hundreds of uploads and thousands.
  it('matches for identical point sets', () => {
    expect(hullKey(Float32Array.from(TETRA))).toBe(hullKey(Float32Array.from(TETRA)));
  });

  it('differs for different shapes', () => {
    const other = [...TETRA];
    other[3] = 2;
    expect(hullKey(Float32Array.from(TETRA))).not.toBe(hullKey(Float32Array.from(other)));
  });

  // Separator-free concatenation would let [1, 23] and [12, 3] collide and
  // silently render one shard with another's geometry.
  it('does not collide across digit boundaries', () => {
    expect(hullKey(Float32Array.from([1, 23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).not.toBe(
      hullKey(Float32Array.from([12, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    );
  });
});

// Assembly, not just selection. The first version of this renderer passed
// every shape-selection test and still drew nothing, because geometries in a
// batch must agree on indexing and attributes and a computed hull agrees with
// a box on neither. That is a throw, and a throw here costs the whole city --
// so the contract is pinned directly.
describe('batching layout', () => {
  const TETRA_POINTS = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);

  it('gives hulls and boxes the same attribute layout', () => {
    const box = buildBoxGeometry();
    const hull = buildHullGeometry(TETRA_POINTS);
    expect(Object.keys(hull.attributes).sort()).toEqual(Object.keys(box.attributes).sort());
    for (const name of Object.keys(box.attributes)) {
      expect(hull.getAttribute(name).itemSize).toBe(box.getAttribute(name).itemSize);
    }
  });

  it('indexes both, since a batch cannot mix indexed and non-indexed', () => {
    expect(buildBoxGeometry().getIndex()).not.toBeNull();
    expect(buildHullGeometry(TETRA_POINTS).getIndex()).not.toBeNull();
  });

  it('builds a hull that encloses its points', () => {
    const hull = buildHullGeometry(TETRA_POINTS);
    expect(hull.getAttribute('position').count).toBeGreaterThanOrEqual(4);
  });

  // The end-to-end guard: three itself validates the batch, so a real
  // BatchedMesh accepting both geometries is the actual proof.
  it('accepts both geometries into one BatchedMesh', () => {
    const box = buildBoxGeometry();
    const hull = buildHullGeometry(TETRA_POINTS);
    const vertices = box.attributes.position.count + hull.attributes.position.count;
    const indices = (box.getIndex()?.count ?? 0) + (hull.getIndex()?.count ?? 0);
    const mesh = new THREE.BatchedMesh(4, vertices, indices, new THREE.MeshStandardMaterial());
    expect(() => {
      const boxId = mesh.addGeometry(box);
      const hullId = mesh.addGeometry(hull);
      mesh.setMatrixAt(mesh.addInstance(boxId), new THREE.Matrix4());
      mesh.setMatrixAt(mesh.addInstance(hullId), new THREE.Matrix4());
    }).not.toThrow();
  });
});

describe('hullKey canonicalisation', () => {
  it('ignores vertex order: the same points are the same solid', () => {
    const a = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const b = Float32Array.from([0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
    expect(hullKey(a)).toBe(hullKey(b));
  });

  it('ignores duplicates: a prism repeats every vertex three times', () => {
    const once = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const thrice = Float32Array.from([...once, ...once, ...once]);
    expect(hullKey(thrice)).toBe(hullKey(once));
  });

  it('still separates genuinely different shapes', () => {
    const a = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const b = Float32Array.from([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(hullKey(a)).not.toBe(hullKey(b));
  });

  it('separates points that differ by more than the rounding grid', () => {
    const a = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const b = Float32Array.from([0, 0, 0, 1.001, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(hullKey(a)).not.toBe(hullKey(b));
  });
});
