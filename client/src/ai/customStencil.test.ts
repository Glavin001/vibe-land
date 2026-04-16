import { describe, it, expect } from 'vitest';
import {
  applyCustomStencilToWorld,
  computeCustomStencilDiff,
  validateCustomStencilDefinition,
  type CustomStencilDefinition,
} from './customStencil';
import type { WorldDocument } from '../world/worldDocument';

function blankWorld(): WorldDocument {
  return {
    version: 2,
    meta: { name: 'test', description: '' },
    terrain: {
      tileGridSize: 3,
      tileHalfExtentM: 8,
      tiles: [
        { tileX: 0, tileZ: 0, heights: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
      ],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

function raiseAllStencil(amount = 5): CustomStencilDefinition {
  return {
    id: 'raise-all',
    name: 'Raise All',
    applyFn: `
      ctx.forEachSample((x, z, currentHeight) => {
        return currentHeight + ctx.params.amount;
      });
    `,
    defaultParams: { amount },
  };
}

describe('validateCustomStencilDefinition', () => {
  it('returns null for a valid definition', () => {
    expect(validateCustomStencilDefinition(raiseAllStencil())).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateCustomStencilDefinition(null)).toMatch(/object/);
    expect(validateCustomStencilDefinition('string')).toMatch(/object/);
  });

  it('rejects missing id', () => {
    expect(validateCustomStencilDefinition({ name: 'X', applyFn: 'return;' })).toMatch(/id/);
  });

  it('rejects missing name', () => {
    expect(validateCustomStencilDefinition({ id: 'x', applyFn: 'return;' })).toMatch(/name/);
  });

  it('rejects missing applyFn', () => {
    expect(validateCustomStencilDefinition({ id: 'x', name: 'X' })).toMatch(/applyFn/);
  });

  it('catches syntax errors in applyFn', () => {
    const def = { id: 'bad', name: 'Bad', applyFn: 'if (' };
    expect(validateCustomStencilDefinition(def)).toMatch(/syntax error/);
  });
});

describe('applyCustomStencilToWorld', () => {
  it('raises all terrain heights by the configured amount', () => {
    const world = blankWorld();
    const def = raiseAllStencil(3);
    const result = applyCustomStencilToWorld(world, def, { amount: 3 }, 0, 0);

    // Original unchanged
    expect(world.terrain.tiles[0].heights.every((h) => h === 0)).toBe(true);

    // All heights should be raised
    expect(result.terrain.tiles[0].heights.every((h) => h === 3)).toBe(true);
  });

  it('returns the same world reference when nothing changes', () => {
    const world = blankWorld();
    const def: CustomStencilDefinition = {
      id: 'noop',
      name: 'Noop',
      applyFn: 'ctx.forEachSample(() => undefined);',
    };
    const result = applyCustomStencilToWorld(world, def, {}, 0, 0);
    expect(result).toBe(world);
  });

  it('clamps heights to TERRAIN_MIN_HEIGHT and TERRAIN_MAX_HEIGHT', () => {
    const world = blankWorld();
    const def: CustomStencilDefinition = {
      id: 'extreme',
      name: 'Extreme',
      applyFn: 'ctx.forEachSample(() => 999);',
    };
    const result = applyCustomStencilToWorld(world, def, {}, 0, 0);
    // TERRAIN_MAX_HEIGHT is 50
    expect(result.terrain.tiles[0].heights.every((h) => h === 50)).toBe(true);
  });

  it('passes correct centerX and centerZ to the applyFn', () => {
    const world = blankWorld();
    const def: CustomStencilDefinition = {
      id: 'center-check',
      name: 'Center Check',
      applyFn: `
        ctx.forEachSample((x, z, h) => {
          const dist = Math.sqrt((x - ctx.centerX) ** 2 + (z - ctx.centerZ) ** 2);
          return dist < 1 ? h + 10 : undefined;
        });
      `,
    };
    const result = applyCustomStencilToWorld(world, def, {}, 0, 0);
    // The center sample (row=1, col=1) at (0,0) should be raised; others depend on distance
    const centerIdx = 4; // 3x3 grid center: row 1, col 1
    expect(result.terrain.tiles[0].heights[centerIdx]).toBe(10);
  });

  it('forEachSample provides correct world-space coordinates', () => {
    const world = blankWorld();
    const collected: Array<{ x: number; z: number }> = [];
    const def: CustomStencilDefinition = {
      id: 'coord-logger',
      name: 'Coord Logger',
      // Store coords in params by mutating the object (unusual but works for testing)
      applyFn: `
        ctx.forEachSample((x, z) => {
          ctx.params._coords.push({ x, z });
          return undefined;
        });
      `,
    };
    const params = { _coords: collected };
    applyCustomStencilToWorld(world, def, params, 0, 0);

    // 3x3 grid = 9 samples
    expect(collected).toHaveLength(9);
    // For tile(0,0) with tileHalfExtentM=8, the grid should span [-8, 8] in both x and z
    expect(collected.some((c) => c.x === -8 && c.z === -8)).toBe(true);
    expect(collected.some((c) => c.x === 8 && c.z === 8)).toBe(true);
    expect(collected.some((c) => c.x === 0 && c.z === 0)).toBe(true);
  });

  it('ctx.sampleHeight returns interpolated terrain height', () => {
    const world = blankWorld();
    // Set center height to 5
    world.terrain.tiles[0].heights[4] = 5;
    let sampledHeight = -1;
    const def: CustomStencilDefinition = {
      id: 'sample-check',
      name: 'Sample Check',
      applyFn: `
        ctx.params._result.value = ctx.sampleHeight(0, 0);
        ctx.forEachSample(() => undefined);
      `,
    };
    const resultHolder = { value: -1 };
    applyCustomStencilToWorld(world, def, { _result: resultHolder }, 0, 0);
    expect(resultHolder.value).toBe(5);
  });

  it('ctx.clamp and ctx.lerp helpers work correctly', () => {
    const world = blankWorld();
    const def: CustomStencilDefinition = {
      id: 'helpers-check',
      name: 'Helpers Check',
      applyFn: `
        ctx.params._results.clampResult = ctx.clamp(15, 0, 10);
        ctx.params._results.lerpResult = ctx.lerp(0, 10, 0.5);
        ctx.forEachSample(() => undefined);
      `,
    };
    const results: Record<string, number> = {};
    applyCustomStencilToWorld(world, def, { _results: results }, 0, 0);
    expect(results.clampResult).toBe(10);
    expect(results.lerpResult).toBe(5);
  });
});

describe('computeCustomStencilDiff', () => {
  it('returns correct diff for a stencil that raises all heights', () => {
    const world = blankWorld();
    const def = raiseAllStencil(2);
    const diff = computeCustomStencilDiff(world, def, { amount: 2 }, 0, 0);

    expect(diff.samples.length).toBe(9); // all 9 samples in 3x3 grid
    expect(diff.raisedCount).toBe(9);
    expect(diff.loweredCount).toBe(0);
    expect(diff.maxAbsDelta).toBeCloseTo(2, 5);
    for (const s of diff.samples) {
      expect(s.beforeY).toBe(0);
      expect(s.afterY).toBe(2);
      expect(s.deltaY).toBe(2);
    }
  });

  it('returns empty diff when stencil changes nothing', () => {
    const world = blankWorld();
    const def: CustomStencilDefinition = {
      id: 'noop',
      name: 'Noop',
      applyFn: 'ctx.forEachSample(() => undefined);',
    };
    const diff = computeCustomStencilDiff(world, def, {}, 0, 0);
    expect(diff.samples).toHaveLength(0);
    expect(diff.maxAbsDelta).toBe(0);
  });

  it('correctly reports raised and lowered counts', () => {
    const world = blankWorld();
    // Set half to 5
    world.terrain.tiles[0].heights = [5, 5, 5, 5, 0, 0, 0, 0, 0];
    const def: CustomStencilDefinition = {
      id: 'flatten',
      name: 'Flatten to 3',
      applyFn: 'ctx.forEachSample((x, z, h) => 3);',
    };
    const diff = computeCustomStencilDiff(world, def, {}, 0, 0);
    // 4 samples at 5 → 3 (lowered), 5 samples at 0 → 3 (raised)
    expect(diff.loweredCount).toBe(4);
    expect(diff.raisedCount).toBe(5);
  });
});
