// A deliberately-minimal world for the calibration wizard: one flat tile, no
// props, no dynamic entities. The point is to remove every possible source of
// visual or geometric interference so drill targets are unmissable and the
// player isn't "contending with space" while trying to find their aim feel.

import type { WorldDocument } from '../world/worldDocument';

const GRID_SIZE = 16;
const HALF_EXTENT_M = 50;

function buildFlatHeights(): number[] {
  // All cells at y=0. The terrain mesh uses these as vertex heights — a
  // uniform value produces a perfectly flat plane.
  return new Array(GRID_SIZE * GRID_SIZE).fill(0);
}

export const CALIBRATION_WORLD_DOCUMENT: WorldDocument = {
  version: 1,
  meta: {
    name: 'Calibration Range',
    description: 'Flat, empty arena used by the input calibration wizard so drill targets are impossible to miss visually.',
  },
  terrain: {
    gridSize: GRID_SIZE,
    halfExtentM: HALF_EXTENT_M,
    heights: buildFlatHeights(),
  },
  staticProps: [],
  dynamicEntities: [],
};
