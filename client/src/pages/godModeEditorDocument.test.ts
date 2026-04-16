import { describe, expect, it } from 'vitest';

import {
  addDynamicEntityToWorld,
  addStaticCuboidToWorld,
  clonePlayWorldSnapshot,
  getSelectedDynamic,
  getSelectedStatic,
  removeSelectedTargetFromWorld,
  resolveSelectedTransformEntity,
  selectionExists,
  updateSelectedTargetHalfExtents,
  updateSelectedTargetPosition,
  updateSelectedTargetRadius,
  updateSelectedTargetRotation,
  type SelectedTarget,
} from './godModeEditorDocument';
import {
  DEFAULT_WORLD_DOCUMENT,
  identityQuaternion,
  type WorldDocument,
} from '../world/worldDocument';

function emptyWorld(): WorldDocument {
  return {
    version: 2,
    meta: { name: 'Test', description: '' },
    terrain: DEFAULT_WORLD_DOCUMENT.terrain,
    staticProps: [],
    dynamicEntities: [],
  };
}

describe('godModeEditorDocument', () => {
  it('adds a static cuboid and selects it', () => {
    const result = addStaticCuboidToWorld(emptyWorld());
    expect(result.world.staticProps).toHaveLength(1);
    expect(result.selected).toEqual({ kind: 'static', id: result.world.staticProps[0]?.id });
  });

  it('adds a dynamic entity and selects it', () => {
    const result = addDynamicEntityToWorld(emptyWorld(), 'ball');
    expect(result.world.dynamicEntities).toHaveLength(1);
    expect(result.selected).toEqual({ kind: 'dynamic', id: result.world.dynamicEntities[0]?.id });
  });

  it('resolves selected transform capabilities for ball vs vehicle', () => {
    let world = emptyWorld();
    world = addDynamicEntityToWorld(world, 'ball').world;
    world = addDynamicEntityToWorld(world, 'vehicle').world;
    const ball = world.dynamicEntities.find((entity) => entity.kind === 'ball')!;
    const vehicle = world.dynamicEntities.find((entity) => entity.kind === 'vehicle')!;

    expect(resolveSelectedTransformEntity(world, { kind: 'dynamic', id: ball.id })).toMatchObject({
      canRotate: false,
      canResize: true,
    });
    expect(resolveSelectedTransformEntity(world, { kind: 'dynamic', id: vehicle.id })).toMatchObject({
      canRotate: true,
      canResize: false,
    });
  });

  it('updates selected world entities without touching others', () => {
    let world = emptyWorld();
    const staticResult = addStaticCuboidToWorld(world);
    world = staticResult.world;
    const dynamicResult = addDynamicEntityToWorld(world, 'box');
    world = dynamicResult.world;

    const staticSelected = staticResult.selected as SelectedTarget;
    const dynamicSelected = dynamicResult.selected as SelectedTarget;
    world = updateSelectedTargetPosition(world, staticSelected, [4, 5, 6]);
    world = updateSelectedTargetHalfExtents(world, staticSelected, [3, 2, 1]);
    world = updateSelectedTargetPosition(world, dynamicSelected, [1, 2, 3]);
    world = updateSelectedTargetHalfExtents(world, dynamicSelected, [0.5, 0.5, 0.5]);

    expect(getSelectedStatic(world, staticSelected)?.position).toEqual([4, 5, 6]);
    expect(getSelectedStatic(world, staticSelected)?.halfExtents).toEqual([3, 2, 1]);
    expect(getSelectedDynamic(world, dynamicSelected)?.position).toEqual([1, 2, 3]);
    expect(getSelectedDynamic(world, dynamicSelected)?.halfExtents).toEqual([0.5, 0.5, 0.5]);
  });

  it('updates ball radius and rotation through shared helpers', () => {
    let world = addDynamicEntityToWorld(emptyWorld(), 'ball').world;
    const selected: SelectedTarget = { kind: 'dynamic', id: world.dynamicEntities[0]!.id };
    const rotation = identityQuaternion();
    rotation[1] = 0.5;
    rotation[3] = 0.5;

    world = updateSelectedTargetRadius(world, selected, 1.25);
    world = updateSelectedTargetRotation(world, selected, rotation);

    expect(getSelectedDynamic(world, selected)?.radius).toBe(1.25);
    expect(getSelectedDynamic(world, selected)?.rotation).toEqual(rotation);
  });

  it('removes selected entities and clears play snapshots by cloning', () => {
    const start = addStaticCuboidToWorld(emptyWorld());
    const selected = start.selected;
    const snapshot = clonePlayWorldSnapshot(start.world);
    const updated = removeSelectedTargetFromWorld(start.world, selected);

    expect(updated.staticProps).toHaveLength(0);
    expect(selectionExists(updated, selected)).toBe(false);
    expect(snapshot).not.toBe(start.world);
    expect(snapshot.staticProps).toHaveLength(1);
  });
});
