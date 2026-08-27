import { describe, expect, it } from 'vitest';

import {
  cuboidHalfExtents,
  isConvexHullGeometry,
  isCuboidGeometry,
  type ChunkGeometry,
  resolveShapeLibrary,
} from './manifest';

describe('city manifest geometry', () => {
  it('reads camelCase halfExtents from the fixed server', () => {
    const geometry = { kind: 'cuboid', halfExtents: [0.5, 1, 1.5] } as unknown as ChunkGeometry;
    expect(isCuboidGeometry(geometry)).toBe(true);
    expect(cuboidHalfExtents(geometry)).toEqual([0.5, 1, 1.5]);
  });

  it('falls back to snake_case half_extents from a pre-fix server', () => {
    // This is the exact payload shape that used to throw
    // "undefined is not iterable" and abort the whole chunk mesh build.
    const geometry = { kind: 'cuboid', half_extents: [2, 3, 4] } as unknown as ChunkGeometry;
    expect(cuboidHalfExtents(geometry)).toEqual([2, 3, 4]);
  });

  it('returns null instead of throwing when a cuboid has no extents at all', () => {
    const geometry = { kind: 'cuboid' } as unknown as ChunkGeometry;
    expect(() => cuboidHalfExtents(geometry)).not.toThrow();
    expect(cuboidHalfExtents(geometry)).toBeNull();
  });

  it('accepts both tag spellings', () => {
    expect(isCuboidGeometry({ kind: 'Cuboid', halfExtents: [1, 1, 1] })).toBe(true);
    expect(isConvexHullGeometry({ kind: 'ConvexHull', points: [0, 0, 0] })).toBe(true);
    expect(isConvexHullGeometry({ kind: 'convexHull', points: [0, 0, 0] })).toBe(true);
  });

  it('does not treat a convex hull as a cuboid', () => {
    const hull = { kind: 'convexHull', points: [0, 0, 0, 1, 1, 1] } as ChunkGeometry;
    expect(isCuboidGeometry(hull)).toBe(false);
    expect(cuboidHalfExtents(hull)).toBeNull();
  });
});

describe('resolveShapeLibrary', () => {
  const hull = (shapeId: number) => ({
    nodeIndex: shapeId,
    centroid: [0, 0, 0] as [number, number, number],
    mass: 1,
    volume: 1,
    size: [1, 1, 1] as [number, number, number],
    geometry: { kind: 'convexHull' as const, points: [] as number[], shapeId },
    radius: 1,
    support: false,
  });
  const manifest = (shapeLibrary?: number[][]) => ({
    version: 1,
    shapeLibrary,
    structures: [{
      structureId: 0,
      worldPosition: [0, 0, 0] as [number, number, number],
      worldRotation: [0, 0, 0, 1] as [number, number, number, number],
      chunks: [hull(0), hull(1), hull(0)],
      bonds: [],
    }],
  });

  it('folds library points back onto the chunks that name them', () => {
    const m = manifest([[1, 2, 3], [4, 5, 6]]);
    resolveShapeLibrary(m as never);
    const chunks = m.structures[0].chunks;
    expect(chunks[0].geometry.points).toEqual([1, 2, 3]);
    expect(chunks[1].geometry.points).toEqual([4, 5, 6]);
  });

  it('SHARES one array between chunks of the same shape', () => {
    // The saving is memory as well as download; copying per chunk would give
    // back the bytes the library just removed.
    const m = manifest([[1, 2, 3], [4, 5, 6]]);
    resolveShapeLibrary(m as never);
    const chunks = m.structures[0].chunks;
    expect(chunks[0].geometry.points).toBe(chunks[2].geometry.points);
  });

  it('throws on a dangling reference rather than drawing the wrong shard', () => {
    const m = manifest([[1, 2, 3]]);
    expect(() => resolveShapeLibrary(m as never)).toThrow(/references shape 1/);
  });

  it('leaves a manifest without a library untouched', () => {
    const m = manifest(undefined);
    m.structures[0].chunks[0].geometry.points = [7, 8, 9];
    resolveShapeLibrary(m as never);
    expect(m.structures[0].chunks[0].geometry.points).toEqual([7, 8, 9]);
  });
});
