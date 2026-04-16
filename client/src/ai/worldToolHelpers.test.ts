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
});
