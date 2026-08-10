import { describe, expect, it } from 'vitest';

import {
  cuboidHalfExtents,
  isConvexHullGeometry,
  isCuboidGeometry,
  type ChunkGeometry,
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
