// Flat, empty world for `/city`, mirroring `city_world()` in
// server/src/demo_world.rs.
//
// The default client world (worlds/trail.world.json) is the Demo World: rolling
// terrain from -5.6 m to +28.9 m, 3 static props and 57 dynamic entities. The
// server does not simulate any of that for a city match — it builds a single
// flat heightfield with no props, and the buildings themselves live in the
// destruction runtime rather than the movement arena.
//
// That mismatch is not only cosmetic. The world document also feeds
// `useGameRuntime`, so the client was predicting movement against hills the
// server does not have, and the towers sat half-buried in a dune.
//
// The terrain parameters here are the server's constants; keep them in sync.

import type { WorldDocument } from './worldDocument';

/** `BENCHMARK_TERRAIN_GRID_SIZE` in server/src/demo_world.rs. */
const TILE_GRID_SIZE = 129;
/** `BENCHMARK_TERRAIN_HALF_EXTENT_M` in server/src/demo_world.rs. */
const TILE_HALF_EXTENT_M = 256;

function flatHeights(): number[] {
  return new Array(TILE_GRID_SIZE * TILE_GRID_SIZE).fill(0);
}

/**
 * Static props and dynamic entities are intentionally empty: the server's city
 * world has none, and vehicles in a multiplayer match arrive over the snapshot
 * stream rather than from this document.
 */
export const CITY_WORLD_DOCUMENT: WorldDocument = {
  version: 2,
  meta: {
    name: 'Destructible City',
    description: 'Flat open world hosting the destructible mini-city grid.',
  },
  terrain: {
    tileGridSize: TILE_GRID_SIZE,
    tileHalfExtentM: TILE_HALF_EXTENT_M,
    tiles: [
      {
        tileX: 0,
        tileZ: 0,
        heights: flatHeights(),
      },
    ],
  },
  staticProps: [],
  dynamicEntities: [],
  spawnAreas: [],
};
