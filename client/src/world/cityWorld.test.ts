import { describe, expect, it } from 'vitest';

import { isCityMatchId } from '../app/matchId';
import { CITY_WORLD_DOCUMENT } from './cityWorld';
import { DEFAULT_WORLD_DOCUMENT } from './worldDocument';

describe('city world document', () => {
  it('matches city match ids the way the server does', () => {
    expect(isCityMatchId('city-default')).toBe(true);
    expect(isCityMatchId('city')).toBe(true);
    expect(isCityMatchId('city-anything-else')).toBe(true);
    expect(isCityMatchId('default')).toBe(false);
    expect(isCityMatchId('my-city')).toBe(false);
  });

  it('is perfectly flat', () => {
    const heights = CITY_WORLD_DOCUMENT.terrain.tiles.flatMap((tile) => tile.heights);
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBe(0);
    expect(Math.max(...heights)).toBe(0);
  });

  it('mirrors the server terrain parameters', () => {
    // server/src/demo_world.rs: BENCHMARK_TERRAIN_GRID_SIZE / _HALF_EXTENT_M.
    expect(CITY_WORLD_DOCUMENT.terrain.tileGridSize).toBe(129);
    expect(CITY_WORLD_DOCUMENT.terrain.tileHalfExtentM).toBe(256);
    expect(CITY_WORLD_DOCUMENT.terrain.tiles).toHaveLength(1);
    expect(CITY_WORLD_DOCUMENT.terrain.tiles[0].heights).toHaveLength(129 * 129);
  });

  it('carries no props or entities the server does not simulate', () => {
    expect(CITY_WORLD_DOCUMENT.staticProps).toEqual([]);
    expect(CITY_WORLD_DOCUMENT.dynamicEntities).toEqual([]);
  });

  it('is not the Demo World, which is neither flat nor empty', () => {
    const demoHeights = DEFAULT_WORLD_DOCUMENT.terrain.tiles.flatMap((tile) => tile.heights);
    // Guards the regression: /city used to render this, so towers sat in dunes
    // and the client predicted movement against hills the server lacks.
    expect(Math.max(...demoHeights) - Math.min(...demoHeights)).toBeGreaterThan(10);
    expect(DEFAULT_WORLD_DOCUMENT.dynamicEntities.length).toBeGreaterThan(0);
  });
});
