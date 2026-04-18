// A deliberately-minimal world for the calibration wizard: one flat tile, no
// props, no dynamic entities. The point is to remove every possible source of
// visual or geometric interference so drill targets are unmissable and the
// player isn't "contending with space" while trying to find their aim feel.

import type { WorldDocument } from '../world/worldDocument';

const TILE_GRID_SIZE = 33; // 33x33 vertices per tile
const TILE_HALF_EXTENT_M = 50;

function buildFlatTileHeights(): number[] {
  // All vertices at y=0. A uniform height produces a perfectly flat plane.
  return new Array(TILE_GRID_SIZE * TILE_GRID_SIZE).fill(0);
}

export const CALIBRATION_WORLD_DOCUMENT: WorldDocument = {
  version: 2,
  meta: {
    name: 'Calibration Range',
    description: 'Flat, empty arena used by the input calibration wizard so drill targets are impossible to miss visually.',
  },
  terrain: {
    tileGridSize: TILE_GRID_SIZE,
    tileHalfExtentM: TILE_HALF_EXTENT_M,
    tiles: [
      {
        tileX: 0,
        tileZ: 0,
        heights: buildFlatTileHeights(),
      },
    ],
  },
  staticProps: [],
  dynamicEntities: [],
  spawnAreas: [],
};
