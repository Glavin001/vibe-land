import { describe, expect, it } from 'vitest';
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  type Vec3,
} from 'navcat';
import { DEFAULT_WORLD_DOCUMENT } from '../../world/worldDocument';
import { buildBotNavMesh } from './buildNavMesh';

describe('buildBotNavMesh', () => {
  it('builds a navmesh with at least one tile from the default world', () => {
    const nav = buildBotNavMesh(DEFAULT_WORLD_DOCUMENT);
    expect(nav.mode).toBe('tiled');
    expect(Object.keys(nav.navMesh.tiles).length).toBeGreaterThan(0);
    expect(nav.geometry.triangleCount).toBeGreaterThan(0);
  });

  it('findNearestPoly succeeds at the world origin', () => {
    const nav = buildBotNavMesh(DEFAULT_WORLD_DOCUMENT);
    const result = findNearestPoly(
      createFindNearestPolyResult(),
      nav.navMesh,
      [0, 5, 0] as Vec3,
      [4, 10, 4] as Vec3,
      DEFAULT_QUERY_FILTER,
    );
    expect(result.success).toBe(true);
  });
});
