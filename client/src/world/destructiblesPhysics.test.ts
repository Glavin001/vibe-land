import { beforeAll, describe, expect, it } from 'vitest';
import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import { serializeWorldDocument, type WorldDocument } from './worldDocument';

/**
 * Stride of the chunk transforms SoA produced by
 * `WasmSimWorld::getDestructibleChunkTransforms`.  Must stay in sync with
 * `CHUNK_TRANSFORM_STRIDE` in `shared/src/destructibles.rs`.
 */
const CHUNK_TRANSFORM_STRIDE = 11;

beforeAll(() => {
  initWasmForTests();
});

function makeFlatTileHeights(gridSize: number): number[] {
  return Array.from({ length: gridSize * gridSize }, () => 0);
}

function makeWallWorld(): WorldDocument {
  const gridSize = 9;
  return {
    version: 2,
    meta: {
      name: 'Wall Destructible Test World',
      description: 'Flat tile with a single Blast wall scenario placed above it.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 16,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: makeFlatTileHeights(gridSize),
      }],
    },
    staticProps: [],
    dynamicEntities: [],
    destructibles: [
      {
        id: 7001,
        kind: 'wall',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
      },
    ],
  };
}

function makeTowerWorld(): WorldDocument {
  const gridSize = 9;
  return {
    version: 2,
    meta: {
      name: 'Tower Destructible Test World',
      description: 'Flat tile with a single Blast tower scenario placed above it.',
    },
    terrain: {
      tileGridSize: gridSize,
      tileHalfExtentM: 16,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: makeFlatTileHeights(gridSize),
      }],
    },
    staticProps: [],
    dynamicEntities: [],
    destructibles: [
      {
        id: 7002,
        kind: 'tower',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
      },
    ],
  };
}

describe('Destructible scenarios (Blast stress solver)', () => {
  it('loads a wall from a world document and produces chunk transforms', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    sim.rebuildBroadPhase();

    expect(sim.getDestructibleInstanceCount()).toBe(1);

    // Priming step so the registry fills its chunk-transform buffer from
    // the initial Rapier body poses.  Before the first step the buffer is
    // empty by design.
    sim.stepDestructibles();

    const count = sim.getDestructibleChunkCount();
    expect(count).toBeGreaterThan(0);

    const transforms = sim.getDestructibleChunkTransforms();
    expect(transforms.length).toBe(count * CHUNK_TRANSFORM_STRIDE);

    // Every row should reference our destructible id in slot 0 and a
    // unit-ish quaternion in slots 5..8.
    const ids = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      ids.add(transforms[base]);
      const qx = transforms[base + 5];
      const qy = transforms[base + 6];
      const qz = transforms[base + 7];
      const qw = transforms[base + 8];
      const qLen = Math.hypot(qx, qy, qz, qw);
      expect(Math.abs(qLen - 1)).toBeLessThan(1e-3);
    }
    expect([...ids]).toEqual([7001]);

    sim.free();
  });

  it('loads a tower with more chunks than a wall', () => {
    const wallSim = new WasmSimWorld();
    wallSim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    wallSim.stepDestructibles();
    const wallCount = wallSim.getDestructibleChunkCount();
    wallSim.free();

    const towerSim = new WasmSimWorld();
    towerSim.loadWorldDocument(serializeWorldDocument(makeTowerWorld()));
    towerSim.stepDestructibles();
    const towerCount = towerSim.getDestructibleChunkCount();
    towerSim.free();

    expect(wallCount).toBeGreaterThan(0);
    expect(towerCount).toBeGreaterThan(0);
    // Default TowerOptions produce more cells than default WallOptions
    // (tower is a full 3D grid, wall is a single-thickness slab).
    expect(towerCount).toBeGreaterThan(wallCount);
  });

  it('stepping the sim leaves bonded wall chunks near their spawn pose', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));
    sim.rebuildBroadPhase();

    sim.stepDestructibles();
    const count = sim.getDestructibleChunkCount();
    expect(count).toBeGreaterThan(0);
    const startTransforms = Float32Array.from(sim.getDestructibleChunkTransforms());

    // Run 60 ticks of the main dynamics pipeline.  With no external
    // contacts and no vehicle slamming into them, the stress solver
    // should keep every bonded chunk within a tiny epsilon of its
    // starting pose (supports hold it up; gravity is balanced by the
    // bond network).
    for (let step = 0; step < 60; step += 1) {
      sim.stepDynamics(1 / 60);
    }

    const endTransforms = sim.getDestructibleChunkTransforms();
    expect(endTransforms.length).toBe(startTransforms.length);

    let maxDelta = 0;
    for (let i = 0; i < count; i += 1) {
      const base = i * CHUNK_TRANSFORM_STRIDE;
      const dx = endTransforms[base + 2] - startTransforms[base + 2];
      const dy = endTransforms[base + 3] - startTransforms[base + 3];
      const dz = endTransforms[base + 4] - startTransforms[base + 4];
      const delta = Math.hypot(dx, dy, dz);
      if (delta > maxDelta) maxDelta = delta;
    }
    expect(maxDelta).toBeLessThan(0.25);

    sim.free();
  });

  it('despawn removes the destructible and clears the chunk buffer', () => {
    const sim = new WasmSimWorld();
    sim.loadWorldDocument(serializeWorldDocument(makeWallWorld()));

    expect(sim.getDestructibleInstanceCount()).toBe(1);
    const despawned = sim.despawnDestructible(7001);
    expect(despawned).toBe(true);
    expect(sim.getDestructibleInstanceCount()).toBe(0);

    sim.stepDestructibles();
    expect(sim.getDestructibleChunkCount()).toBe(0);
    expect(sim.getDestructibleChunkTransforms().length).toBe(0);

    sim.free();
  });
});
