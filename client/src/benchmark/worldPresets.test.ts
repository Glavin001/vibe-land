import { describe, expect, it } from 'vitest';
import {
  createBenchmarkWorldPreset,
  createFlatVehicleBenchmarkWorld,
  createVehicleBumpsBenchmarkWorld,
} from './worldPresets';
import { DEFAULT_WORLD_DOCUMENT, terrainTileSampleCount } from '../world/worldDocument';

describe('benchmark world presets', () => {
  it('builds the flat vehicle benchmark document used by server match prefixes', () => {
    const world = createFlatVehicleBenchmarkWorld();

    expect(world.terrain.tileGridSize).toBe(129);
    expect(world.terrain.tileHalfExtentM).toBe(256);
    expect(world.terrain.tiles).toHaveLength(1);
    expect(world.terrain.tiles[0].heights).toHaveLength(terrainTileSampleCount(world));
    expect(new Set(world.terrain.tiles[0].heights)).toEqual(new Set([0]));
    expect(world.staticProps).toHaveLength(0);
    expect(world.dynamicEntities).toEqual([{
      id: 1,
      kind: 'vehicle',
      position: [0, 3, 3],
      rotation: [0, 0, 0, 1],
      vehicleType: 0,
    }]);
  });

  it('builds the bumps vehicle benchmark document used by server match prefixes', () => {
    const world = createVehicleBumpsBenchmarkWorld();
    const heights = world.terrain.tiles[0].heights;

    expect(heights).toHaveLength(terrainTileSampleCount(world));
    expect(Math.max(...heights)).toBeGreaterThan(0.2);
    expect(Math.min(...heights)).toBe(0);
    expect(world.dynamicEntities).toHaveLength(1);
  });

  it('leaves default benchmark worlds on the caller-provided world document', () => {
    expect(createBenchmarkWorldPreset('default', DEFAULT_WORLD_DOCUMENT)).toBe(DEFAULT_WORLD_DOCUMENT);
  });
});
