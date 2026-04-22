import { describe, it, expect } from 'vitest';
import { buildWorldCtx, type WorldAccessors } from './worldToolHelpers';
import {
  cloneWorldDocument,
  identityQuaternion,
  type WorldDocument,
} from '../world/worldDocument';

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
    spawnAreas: [],
  };
}

function makeAccessors(initial: WorldDocument): {
  accessors: WorldAccessors;
  current: () => WorldDocument;
  edits: number;
  aiEditCount: () => number;
} {
  let current = initial;
  let edits = 0;
  let aiEditCount = 0;
  const splines = new Map<string, import('./splineData').SplineData>();
  const accessors: WorldAccessors = {
    getWorld: () => current,
    commitEdit: (updater, options) => {
      const next = updater(current);
      if (next === current) return false;
      current = next;
      edits += 1;
      if (options?.isAiEdit) aiEditCount += 1;
      return true;
    },
    applyWithoutCommit: (updater) => {
      const next = updater(current);
      if (next === current) return false;
      current = next;
      edits += 1;
      return true;
    },
    restoreWorld: (snapshot) => {
      current = snapshot;
    },
    commitAsAi: () => {
      // no-op in tests
    },
    rollbackToCommit: () => {
      return { ok: false, message: 'not implemented in tests' };
    },
    getSplines: () => splines,
    setSpline: (id, spline) => { splines.set(id, spline); },
    deleteSpline: (id) => splines.delete(id),
  };
  return {
    accessors,
    current: () => current,
    get edits() {
      return edits;
    },
    aiEditCount: () => aiEditCount,
  } as never;
}

describe('buildWorldCtx', () => {
  it('addStaticCuboid pushes a new cuboid via commitEdit and returns its id', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);

    const result = ctx.addStaticCuboid({
      position: [1, 0, 2],
      halfExtents: [0.5, 0.5, 0.5],
    });

    expect(result.changed).toBe(true);
    expect(typeof result.id).toBe('number');
    const world = env.current();
    expect(world.staticProps).toHaveLength(1);
    expect(world.staticProps[0].position).toEqual([1, 0, 2]);
    expect(world.staticProps[0].id).toBe(result.id);
    // mutation should be marked as AI-originated
    expect(env.aiEditCount()).toBe(1);
  });

  it('addStaticCuboid validates inputs and returns a reason on failure', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const badPosition = ctx.addStaticCuboid({
      // @ts-expect-error testing runtime guard
      position: ['nope', 0, 0],
      halfExtents: [1, 1, 1],
    });
    expect(badPosition.changed).toBe(false);
    expect(badPosition.reason).toMatch(/position/);
    expect(env.current().staticProps).toHaveLength(0);
  });

  it('removeEntity and updateEntity operate on the right id', () => {
    const initial = blankWorld();
    initial.dynamicEntities.push({
      id: 5,
      kind: 'box',
      position: [0, 0, 0],
      rotation: identityQuaternion(),
      halfExtents: [1, 1, 1],
    });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);

    const updated = ctx.updateEntity(5, { position: [3, 0, 0] });
    expect(updated.changed).toBe(true);
    expect(env.current().dynamicEntities[0].position).toEqual([3, 0, 0]);

    const removed = ctx.removeEntity(5);
    expect(removed.changed).toBe(true);
    expect(env.current().dynamicEntities).toHaveLength(0);

    const missing = ctx.removeEntity(5);
    expect(missing.changed).toBe(false);
    expect(missing.reason).toContain('no entity');
  });

  it('getWorld returns a deep clone (mutations do not bleed through)', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const snapshot = ctx.getWorld();
    snapshot.staticProps.push({
      id: 99,
      kind: 'cuboid',
      position: [0, 0, 0],
      rotation: identityQuaternion(),
      halfExtents: [1, 1, 1],
    });
    expect(env.current().staticProps).toHaveLength(0);
  });

  it('applyTerrainBrush mutates terrain heights', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.applyTerrainBrush({
      centerX: 0,
      centerZ: 0,
      radius: 12,
      strength: 4,
      mode: 'raise',
    });
    expect(result.changed).toBe(true);
    const after = env.current().terrain.tiles[0].heights;
    expect(after.some((h) => h > 0)).toBe(true);
  });

  it('applyTerrainBrush returns rich stats payload', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.applyTerrainBrush({
      centerX: 0, centerZ: 0, radius: 12, strength: 2, mode: 'raise',
    });
    expect(result.changed).toBe(true);
    expect(typeof result.samplesAffected).toBe('number');
    expect((result.samplesAffected ?? 0) > 0).toBe(true);
    expect(typeof result.deltaMin).toBe('number');
    expect(typeof result.deltaMax).toBe('number');
    expect(typeof result.heightMin).toBe('number');
    expect(typeof result.heightMax).toBe('number');
  });

  it('flattenTerrain moves heights toward targetHeight', () => {
    const initial = blankWorld();
    // Start with all heights at 10
    initial.terrain.tiles[0].heights = initial.terrain.tiles[0].heights.map(() => 10);
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.flattenTerrain({ centerX: 0, centerZ: 0, radius: 20, targetHeight: 2, strength: 1 });
    expect(result.changed).toBe(true);
    // Center sample should have moved toward 2 (all heights were 10)
    const after = env.current().terrain.tiles[0].heights;
    const centerIdx = 4; // center of 3x3 grid
    expect(after[centerIdx]).toBeLessThan(10);
    expect(after[centerIdx]).toBeGreaterThanOrEqual(2);
    expect(result.samplesAffected).toBeGreaterThan(0);
  });

  it('flattenTerrain returns changed:false when terrain already at target', () => {
    const env = makeAccessors(blankWorld()); // all heights = 0
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.flattenTerrain({ centerX: 0, centerZ: 0, radius: 20, targetHeight: 0, strength: 1 });
    expect(result.changed).toBe(false);
  });

  it('smoothTerrain reduces a spike', () => {
    const initial = blankWorld();
    // Set center height to 10, all others 0
    const centerIdx = 4; // row=1, col=1 in 3x3 grid
    initial.terrain.tiles[0].heights[centerIdx] = 10;
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.smoothTerrain({ centerX: 0, centerZ: 0, radius: 20, strength: 1 });
    expect(result.changed).toBe(true);
    const after = env.current().terrain.tiles[0].heights;
    // Center spike should be reduced
    expect(after[centerIdx]).toBeLessThan(10);
  });

  it('applyTerrainNoise changes heights inside radius, leaves outside unchanged', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const before = [...env.current().terrain.tiles[0].heights];
    // Use a small radius so we know some samples fall outside
    ctx.applyTerrainNoise({ centerX: 0, centerZ: 0, radius: 2, amplitude: 5, scale: 5, octaves: 2, seed: 99 });
    const after = env.current().terrain.tiles[0].heights;
    // At least some heights should differ
    const changed = after.filter((h, i) => Math.abs(h - before[i]) > 1e-6).length;
    expect(changed).toBeGreaterThan(0);
  });

  it('carveSpline flatten mode sets heights along the path toward targetHeight', () => {
    const initial = blankWorld();
    // Start all heights at 5
    initial.terrain.tiles[0].heights = initial.terrain.tiles[0].heights.map(() => 5);
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.carveSpline({
      points: [{ x: -20, z: 0 }, { x: 20, z: 0 }],
      width: 20, falloffM: 0, mode: 'flatten', strength: 1, targetHeight: 0,
    });
    expect(result.changed).toBe(true);
    // Heights should have moved toward 0
    const after = env.current().terrain.tiles[0].heights;
    expect(after.some((h) => h < 5)).toBe(true);
  });

  it('carveSpline returns changed:false with fewer than 2 points', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    // @ts-expect-error testing runtime guard
    const result = ctx.carveSpline({ points: [{ x: 0, z: 0 }], width: 5, falloffM: 1, mode: 'flatten', strength: 1 });
    expect(result.changed).toBe(false);
  });

  it('findEntitiesInRadius returns only entities within radius', () => {
    const initial = blankWorld();
    initial.staticProps.push(
      { id: 1, kind: 'cuboid', position: [0, 0, 0], rotation: identityQuaternion(), halfExtents: [1, 1, 1] },
      { id: 2, kind: 'cuboid', position: [100, 0, 100], rotation: identityQuaternion(), halfExtents: [1, 1, 1] },
    );
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const results = ctx.findEntitiesInRadius({ x: 0, z: 0, radius: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].entity.id).toBe(1);
  });

  it('findEntitiesInRadius with y/yRadius filters by vertical band', () => {
    const initial = blankWorld();
    initial.dynamicEntities.push(
      { id: 10, kind: 'ball', position: [0, 1, 0], rotation: identityQuaternion(), radius: 0.5 },
      { id: 11, kind: 'ball', position: [0, 50, 0], rotation: identityQuaternion(), radius: 0.5 },
    );
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const results = ctx.findEntitiesInRadius({ x: 0, z: 0, radius: 5, y: 1, yRadius: 2 });
    expect(results).toHaveLength(1);
    expect(results[0].entity.id).toBe(10);
  });

  it('findEntitiesInBox returns only entities within box', () => {
    const initial = blankWorld();
    initial.staticProps.push(
      { id: 1, kind: 'cuboid', position: [2, 0, 2], rotation: identityQuaternion(), halfExtents: [1, 1, 1] },
      { id: 2, kind: 'cuboid', position: [50, 0, 50], rotation: identityQuaternion(), halfExtents: [1, 1, 1] },
    );
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const results = ctx.findEntitiesInBox({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].entity.id).toBe(1);
  });

  it('getTerrainTileBounds returns correct world-space AABB', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    // blankWorld has tileHalfExtentM: 8, tile at (0,0)
    const bounds = ctx.getTerrainTileBounds(0, 0);
    expect(bounds.minX).toBe(-8);
    expect(bounds.maxX).toBe(8);
    expect(bounds.minZ).toBe(-8);
    expect(bounds.maxZ).toBe(8);
  });

  it('getTerrainTileCenter returns correct world-space center', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    // tileHalfExtentM: 8, so side=16; tile (1,0) center = (16, 0)
    const center = ctx.getTerrainTileCenter(1, 0);
    expect(center.x).toBe(16);
    expect(center.z).toBe(0);
  });

  it('getTerrainRegionStats returns correct min/max/avg', () => {
    const initial = blankWorld();
    initial.terrain.tiles[0].heights = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const stats = ctx.getTerrainRegionStats({ centerX: 0, centerZ: 0, radius: 100 });
    expect(stats.sampleCount).toBe(9);
    expect(stats.minHeight).toBe(1);
    expect(stats.maxHeight).toBe(9);
    expect(stats.avgHeight).toBeCloseTo(5, 5);
  });

  it('registerCustomStencil returns registered:true for a valid definition', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.registerCustomStencil({
      id: 'test-stencil',
      name: 'Test Stencil',
      applyFn: 'ctx.forEachSample((x, z, h) => h + 1);',
    });
    expect(result.registered).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('registerCustomStencil returns error for invalid definition', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.registerCustomStencil({
      id: '',
      name: 'Bad',
      applyFn: 'return;',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result.registered).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('applyCustomStencil modifies terrain and returns mutation stats', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    ctx.registerCustomStencil({
      id: 'raise-2',
      name: 'Raise 2',
      applyFn: 'ctx.forEachSample((x, z, h) => h + 2);',
    });
    const result = ctx.applyCustomStencil('raise-2', 0, 0);
    expect(result.changed).toBe(true);
    expect(typeof result.samplesAffected).toBe('number');
    expect((result.samplesAffected ?? 0)).toBeGreaterThan(0);
    const after = env.current().terrain.tiles[0].heights;
    expect(after.every((h) => h === 2)).toBe(true);
  });

  it('applyCustomStencil returns error for unknown stencil id', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.applyCustomStencil('nonexistent', 0, 0);
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/nonexistent/);
  });

  it('addSpawnArea pushes a new spawn area and returns its id', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.addSpawnArea({ position: [4, 0, -3], radius: 8 });
    expect(result.changed).toBe(true);
    expect(typeof result.id).toBe('number');
    const world = env.current();
    expect(world.spawnAreas).toHaveLength(1);
    expect(world.spawnAreas[0]).toEqual({ id: result.id, position: [4, 0, -3], radius: 8 });
    expect(env.aiEditCount()).toBe(1);
  });

  it('addSpawnArea rejects radius < 1 and bad position', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    expect(ctx.addSpawnArea({ position: [0, 0, 0], radius: 0 }).reason).toMatch(/radius/);
    expect(
      // @ts-expect-error testing runtime guard
      ctx.addSpawnArea({ position: [0, 0], radius: 5 }).reason,
    ).toMatch(/position/);
    expect(env.current().spawnAreas).toHaveLength(0);
  });

  it('updateSpawnArea patches position and radius', () => {
    const initial = blankWorld();
    initial.spawnAreas.push({ id: 1, position: [0, 0, 0], radius: 5 });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.updateSpawnArea(1, { position: [10, 0, 10], radius: 12 });
    expect(result.changed).toBe(true);
    expect(env.current().spawnAreas[0]).toEqual({ id: 1, position: [10, 0, 10], radius: 12 });
  });

  it('updateSpawnArea rejects unknown id and bad radius', () => {
    const initial = blankWorld();
    initial.spawnAreas.push({ id: 1, position: [0, 0, 0], radius: 5 });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    expect(ctx.updateSpawnArea(999, { radius: 6 }).reason).toContain('no spawn area');
    expect(ctx.updateSpawnArea(1, { radius: 0 }).reason).toMatch(/radius/);
    expect(env.current().spawnAreas[0].radius).toBe(5);
  });

  it('removeSpawnArea drops by id and reports unknown', () => {
    const initial = blankWorld();
    initial.spawnAreas.push({ id: 1, position: [0, 0, 0], radius: 5 });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    expect(ctx.removeSpawnArea(1).changed).toBe(true);
    expect(env.current().spawnAreas).toHaveLength(0);
    expect(ctx.removeSpawnArea(1).reason).toContain('no spawn area');
  });

  it('listSpawnAreas / getSpawnArea return clones of state', () => {
    const initial = blankWorld();
    initial.spawnAreas.push({ id: 7, position: [1, 0, 2], radius: 3 });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const list = ctx.listSpawnAreas();
    expect(list).toHaveLength(1);
    list[0].radius = 999;
    expect(env.current().spawnAreas[0].radius).toBe(3);
    const single = ctx.getSpawnArea(7);
    expect(single).toEqual({ id: 7, position: [1, 0, 2], radius: 3 });
    expect(ctx.getSpawnArea(404)).toBeNull();
  });

  it('findEntitiesInRadius includes spawn areas with kind: "spawnArea"', () => {
    const initial = blankWorld();
    initial.spawnAreas.push(
      { id: 1, position: [0, 0, 0], radius: 5 },
      { id: 2, position: [100, 0, 100], radius: 5 },
    );
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const results = ctx.findEntitiesInRadius({ x: 0, z: 0, radius: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('spawnArea');
    expect(results[0].entity.id).toBe(1);
  });

  it('findEntitiesInBox includes spawn areas', () => {
    const initial = blankWorld();
    initial.spawnAreas.push({ id: 5, position: [1, 0, 1], radius: 4 });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    const results = ctx.findEntitiesInBox({ minX: -2, maxX: 2, minZ: -2, maxZ: 2 });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('spawnArea');
  });

  it('listTerrainMaterials exposes default materials with index/name/color', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const materials = ctx.listTerrainMaterials();
    expect(materials.length).toBeGreaterThan(0);
    expect(materials[0]).toHaveProperty('index', 0);
    expect(typeof materials[0].name).toBe('string');
    expect(typeof materials[0].color).toBe('string');
    expect(materials.some((m) => m.name === 'grass')).toBe(true);
  });

  it('paintTerrainMaterial accepts material name and writes splatmap weights', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.paintTerrainMaterial({
      centerX: 0, centerZ: 0, radius: 12, strength: 1, material: 'pavement',
    });
    expect(result.changed).toBe(true);
    const tile = env.current().terrain.tiles[0];
    expect(tile.materialWeights).toBeDefined();
    expect((tile.materialWeights ?? []).length).toBeGreaterThan(0);
  });

  it('paintTerrainMaterial accepts material index too', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.paintTerrainMaterial({
      centerX: 0, centerZ: 0, radius: 12, strength: 1, material: 0,
    });
    expect(result.changed).toBe(true);
  });

  it('paintTerrainMaterial rejects unknown material', () => {
    const env = makeAccessors(blankWorld());
    const ctx = buildWorldCtx(env.accessors);
    const result = ctx.paintTerrainMaterial({
      centerX: 0, centerZ: 0, radius: 12, strength: 1, material: 'unobtainium',
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('unobtainium');
    const result2 = ctx.paintTerrainMaterial({
      centerX: 0, centerZ: 0, radius: 12, strength: 1, material: 9999,
    });
    expect(result2.changed).toBe(false);
    expect(result2.reason).toMatch(/9999/);
  });

  it('updateEntity patches vehicleType only on vehicle entities', () => {
    const initial = blankWorld();
    initial.dynamicEntities.push(
      { id: 1, kind: 'vehicle', position: [0, 0, 0], rotation: identityQuaternion(), vehicleType: 0 },
      { id: 2, kind: 'box', position: [0, 0, 0], rotation: identityQuaternion(), halfExtents: [1, 1, 1] },
    );
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);

    expect(ctx.updateEntity(1, { vehicleType: 3 }).changed).toBe(true);
    expect(env.current().dynamicEntities[0].vehicleType).toBe(3);

    // box: vehicleType in patch is silently ignored (no field added)
    ctx.updateEntity(2, { vehicleType: 7 });
    expect(env.current().dynamicEntities[1].vehicleType).toBeUndefined();
  });

  it('updateEntity patches material on static cuboids', () => {
    const initial = blankWorld();
    initial.staticProps.push({
      id: 1, kind: 'cuboid', position: [0, 0, 0], rotation: identityQuaternion(),
      halfExtents: [1, 1, 1], material: 'editor-static',
    });
    const env = makeAccessors(initial);
    const ctx = buildWorldCtx(env.accessors);
    expect(ctx.updateEntity(1, { material: 'metal' }).changed).toBe(true);
    expect(env.current().staticProps[0].material).toBe('metal');
  });
});
