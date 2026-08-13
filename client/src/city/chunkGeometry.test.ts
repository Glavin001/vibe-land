// Shape selection for chunk rendering: which chunks become hulls, which fall
// back to boxes, and when two hulls are the same geometry.

import { describe, expect, it } from 'vitest';

import { MIN_HULL_POINTS, boxScale, chunkShape, hullKey } from './chunkGeometry';
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
