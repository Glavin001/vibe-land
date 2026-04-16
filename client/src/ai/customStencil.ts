import {
  clampNumber,
  getTerrainTileWorldPosition,
  getTerrainWorldBounds,
  lerp,
  sampleTerrainHeightAtWorldPosition,
  TERRAIN_MAX_HEIGHT,
  TERRAIN_MIN_HEIGHT,
  type WorldDocument,
} from '../world/worldDocument';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CustomStencilDefinition = {
  id: string;
  name: string;
  description?: string;

  /** JSON Schema (draft-07) describing configurable parameters. */
  parameterSchema?: Record<string, unknown>;
  /** Default values for the parameters. */
  defaultParams?: Record<string, unknown>;
  /** react-jsonschema-form UI schema hints. */
  uiSchema?: Record<string, unknown>;

  /**
   * JavaScript function body executed to modify terrain.
   * Receives a single `ctx` argument with helpers — see StencilApplyCtx.
   */
  applyFn: string;
};

/**
 * The context object injected as `ctx` into the compiled `applyFn`.
 * This is the public API the AI's code can use.
 */
export type StencilApplyCtx = {
  params: Record<string, unknown>;
  centerX: number;
  centerZ: number;
  forEachSample(callback: (x: number, z: number, currentHeight: number) => number | undefined): void;
  sampleHeight(x: number, z: number): number;
  terrainInfo: {
    tileGridSize: number;
    tileHalfExtentM: number;
    tileCount: number;
    bounds: ReturnType<typeof getTerrainWorldBounds>;
  };
  clamp(value: number, min: number, max: number): number;
  lerp(a: number, b: number, t: number): number;
  TERRAIN_MIN_HEIGHT: number;
  TERRAIN_MAX_HEIGHT: number;
};

export type StencilDiffSample = {
  x: number;
  z: number;
  beforeY: number;
  afterY: number;
  deltaY: number;
};

export type StencilDiffResult = {
  samples: StencilDiffSample[];
  raisedCount: number;
  loweredCount: number;
  maxAbsDelta: number;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateCustomStencilDefinition(def: unknown): string | null {
  if (!def || typeof def !== 'object') return 'definition must be an object';
  const d = def as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.length === 0) return 'id must be a non-empty string';
  if (typeof d.name !== 'string' || d.name.length === 0) return 'name must be a non-empty string';
  if (typeof d.applyFn !== 'string' || d.applyFn.length === 0) return 'applyFn must be a non-empty string';

  // Attempt to compile the applyFn to catch syntax errors early.
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function('ctx', `"use strict";\n${d.applyFn}`);
  } catch (err) {
    return `applyFn has a syntax error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Apply engine
// ---------------------------------------------------------------------------

/**
 * Compile and run a custom stencil's `applyFn` against the world.
 * Returns a new WorldDocument (immutable — original is never mutated).
 * Follows the same copy-on-write tile pattern as the built-in terrain functions.
 */
export function applyCustomStencilToWorld(
  world: WorldDocument,
  definition: CustomStencilDefinition,
  params: Record<string, unknown>,
  centerX: number,
  centerZ: number,
): WorldDocument {
  // Compile the function body (cached per call — consider caching if perf matters)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const runner = new Function('ctx', `"use strict";\n${definition.applyFn}`) as (ctx: StencilApplyCtx) => void;

  // Immutable shell (same pattern as applyTerrainRampStencil, flattenTerrainBrush, etc.)
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  let mutated = false;

  // Build the ctx object for the user's code
  const ctx: StencilApplyCtx = {
    params,
    centerX,
    centerZ,

    forEachSample(callback) {
      for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
        const sourceTile = world.terrain.tiles[tileIndex];
        let nextTile = next.terrain.tiles[tileIndex];
        for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
          for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
            const [x, z] = getTerrainTileWorldPosition(world, sourceTile, row, col);
            const index = row * world.terrain.tileGridSize + col;
            const currentHeight = sourceTile.heights[index] ?? 0;

            const result = callback(x, z, currentHeight);
            if (result === undefined || result === null) continue;

            const nextHeight = clampNumber(result, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
            if (Math.abs(nextHeight - currentHeight) <= 1e-6) continue;

            if (nextTile === sourceTile) {
              nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
              next.terrain.tiles[tileIndex] = nextTile;
            }
            nextTile.heights[index] = nextHeight;
            mutated = true;
          }
        }
      }
    },

    sampleHeight(x, z) {
      return sampleTerrainHeightAtWorldPosition(world, x, z);
    },

    terrainInfo: {
      tileGridSize: world.terrain.tileGridSize,
      tileHalfExtentM: world.terrain.tileHalfExtentM,
      tileCount: world.terrain.tiles.length,
      bounds: getTerrainWorldBounds(world),
    },

    clamp: clampNumber,
    lerp,
    TERRAIN_MIN_HEIGHT,
    TERRAIN_MAX_HEIGHT,
  };

  runner(ctx);

  return mutated ? next : world;
}

// ---------------------------------------------------------------------------
// Diff computation (for visualization)
// ---------------------------------------------------------------------------

/**
 * Dry-run the stencil on a clone of the world and compute per-sample deltas.
 * Used by the preview component to show exactly what will change.
 */
export function computeCustomStencilDiff(
  world: WorldDocument,
  definition: CustomStencilDefinition,
  params: Record<string, unknown>,
  centerX: number,
  centerZ: number,
): StencilDiffResult {
  const after = applyCustomStencilToWorld(world, definition, params, centerX, centerZ);

  // If the world reference didn't change, nothing happened.
  if (after === world) {
    return { samples: [], raisedCount: 0, loweredCount: 0, maxAbsDelta: 0 };
  }

  const samples: StencilDiffSample[] = [];
  let raisedCount = 0;
  let loweredCount = 0;
  let maxAbsDelta = 0;

  for (const afterTile of after.terrain.tiles) {
    const beforeTile = world.terrain.tiles.find(
      (t) => t.tileX === afterTile.tileX && t.tileZ === afterTile.tileZ,
    );
    // Reference equality: unchanged tiles share the same object in copy-on-write.
    if (!beforeTile || beforeTile === afterTile) continue;

    for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
        const index = row * world.terrain.tileGridSize + col;
        const beforeY = beforeTile.heights[index] ?? 0;
        const afterY = afterTile.heights[index] ?? 0;
        const deltaY = afterY - beforeY;
        if (Math.abs(deltaY) <= 1e-6) continue;

        const [x, z] = getTerrainTileWorldPosition(world, afterTile, row, col);
        samples.push({ x, z, beforeY, afterY, deltaY });

        const absDelta = Math.abs(deltaY);
        if (absDelta > maxAbsDelta) maxAbsDelta = absDelta;
        if (deltaY > 0) raisedCount += 1;
        else loweredCount += 1;
      }
    }
  }

  return { samples, raisedCount, loweredCount, maxAbsDelta };
}
