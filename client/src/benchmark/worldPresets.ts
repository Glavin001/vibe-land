import {
  WORLD_DOCUMENT_VERSION,
  identityQuaternion,
  type WorldDocument,
} from '../world/worldDocument';
import type { PlayBenchmarkWorldPreset } from '../loadtest/scenario';

const BENCHMARK_TERRAIN_GRID_SIZE = 129;
const BENCHMARK_TERRAIN_HALF_EXTENT_M = 256;

function benchmarkVehicleWorld(
  name: string,
  description: string,
  heights: number[],
): WorldDocument {
  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: {
      name,
      description,
    },
    terrain: {
      tileGridSize: BENCHMARK_TERRAIN_GRID_SIZE,
      tileHalfExtentM: BENCHMARK_TERRAIN_HALF_EXTENT_M,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights,
      }],
    },
    staticProps: [],
    dynamicEntities: [{
      id: 1,
      kind: 'vehicle',
      position: [0, 3, 3],
      rotation: identityQuaternion(),
      vehicleType: 0,
    }],
  };
}

export function createFlatVehicleBenchmarkWorld(): WorldDocument {
  return benchmarkVehicleWorld(
    'Flat Vehicle Benchmark',
    'Flat multiplayer world used for deterministic local driver vehicle benchmarks.',
    Array.from({ length: BENCHMARK_TERRAIN_GRID_SIZE * BENCHMARK_TERRAIN_GRID_SIZE }, () => 0),
  );
}

export function createVehicleBumpsBenchmarkWorld(): WorldDocument {
  const gridSize = BENCHMARK_TERRAIN_GRID_SIZE;
  const maxIndex = gridSize - 1;
  const halfExtentM = BENCHMARK_TERRAIN_HALF_EXTENT_M;
  const sideM = halfExtentM * 2;
  const heights = Array.from({ length: gridSize * gridSize }, (_, index) => {
    const row = Math.floor(index / gridSize);
    const col = index % gridSize;
    const worldX = (col / maxIndex) * sideM - halfExtentM;
    const worldZ = (row / maxIndex) * sideM - halfExtentM;
    const trackWeight = Math.max(0, Math.min(1, 1 - Math.abs(worldX) / 6));
    const bumpEnvelope = Math.max(0, Math.min(1, (worldZ - 8) / 14));
    const bumpWave = worldZ >= 8 && worldZ <= 22
      ? Math.abs(Math.sin(((worldZ - 8) / 14) * Math.PI * 4)) * 0.35
      : 0;
    return trackWeight * bumpEnvelope * bumpWave;
  });
  return benchmarkVehicleWorld(
    'Vehicle Bumps Benchmark',
    'Benchmark track with mild bumps for multiplayer vehicle-driver validation.',
    heights,
  );
}

export function createBenchmarkWorldPreset(
  preset: PlayBenchmarkWorldPreset,
  defaultWorld: WorldDocument,
): WorldDocument {
  switch (preset) {
    case 'flat_vehicle_test':
      return createFlatVehicleBenchmarkWorld();
    case 'vehicle_bumps_test':
      return createVehicleBumpsBenchmarkWorld();
    case 'default':
      return defaultWorld;
  }
}
