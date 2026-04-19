import { describe, expect, it } from 'vitest';

import {
  addBotToWorld,
  addDynamicEntityToWorld,
  addSpawnAreaToWorld,
  addStaticCuboidToWorld,
  clonePlayWorldSnapshot,
  getSelectedBot,
  getSelectedDynamic,
  getSelectedSpawnArea,
  getSelectedStatic,
  removeSelectedTargetFromWorld,
  resolveSelectedTransformEntity,
  selectionExists,
  updateSelectedBotBehavior,
  updateSelectedBotMaxSpeed,
  updateSelectedBotName,
  updateSelectedBotSpawnArea,
  updateSelectedTargetHalfExtents,
  updateSelectedTargetPosition,
  updateSelectedTargetRadius,
  updateSelectedTargetRotation,
  updateSelectedTargetVehicleType,
  updateSpawnAreaAllowedKind,
  type SelectedTarget,
} from './godModeEditorDocument';
import {
  DEFAULT_WORLD_DOCUMENT,
  identityQuaternion,
  parseWorldDocument,
  WORLD_DOCUMENT_VERSION,
  type WorldDocument,
} from '../world/worldDocument';

function emptyWorld(): WorldDocument {
  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: { name: 'Test', description: '' },
    terrain: DEFAULT_WORLD_DOCUMENT.terrain,
    staticProps: [],
    dynamicEntities: [],
    spawnAreas: [],
    bots: [],
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

  it('updates vehicle type through shared helpers', () => {
    let world = addDynamicEntityToWorld(emptyWorld(), 'vehicle').world;
    const selected: SelectedTarget = { kind: 'dynamic', id: world.dynamicEntities[0]!.id };

    world = updateSelectedTargetVehicleType(world, selected, 0);

    expect(getSelectedDynamic(world, selected)?.vehicleType).toBe(0);
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

  it('adds a spawn area with default allowed kinds for both humans and bots', () => {
    const result = addSpawnAreaToWorld(emptyWorld());
    expect(result.world.spawnAreas).toHaveLength(1);
    expect(result.world.spawnAreas[0]?.allowedKinds).toEqual(['human', 'bot']);
    expect(result.selected).toEqual({ kind: 'spawnArea', id: result.world.spawnAreas[0]?.id });
  });

  it('toggles allowed kinds on a spawn area while keeping at least one kind', () => {
    let world = addSpawnAreaToWorld(emptyWorld()).world;
    const area = world.spawnAreas[0]!;
    const selected: SelectedTarget = { kind: 'spawnArea', id: area.id };

    world = updateSpawnAreaAllowedKind(world, selected, 'bot', false);
    expect(getSelectedSpawnArea(world, selected)?.allowedKinds).toEqual(['human']);

    // Refusing to remove the last kind keeps the value unchanged.
    world = updateSpawnAreaAllowedKind(world, selected, 'human', false);
    expect(getSelectedSpawnArea(world, selected)?.allowedKinds).toEqual(['human']);

    world = updateSpawnAreaAllowedKind(world, selected, 'bot', true);
    expect(getSelectedSpawnArea(world, selected)?.allowedKinds).toEqual(['human', 'bot']);
  });

  it('adds and edits a preconfigured bot', () => {
    let world = emptyWorld();
    const added = addBotToWorld(world);
    world = added.world;
    expect(world.bots).toHaveLength(1);
    const selected = added.selected as SelectedTarget;

    world = updateSelectedBotName(world, selected, 'Harasser');
    world = updateSelectedBotBehavior(world, selected, 'wander');
    world = updateSelectedBotMaxSpeed(world, selected, 7);
    world = updateSelectedBotSpawnArea(world, selected, 42);

    const bot = getSelectedBot(world, selected);
    expect(bot?.name).toBe('Harasser');
    expect(bot?.behavior).toBe('wander');
    expect(bot?.maxSpeed).toBe(7);
    expect(bot?.spawnAreaId).toBe(42);

    // Clearing fields works.
    world = updateSelectedBotName(world, selected, '');
    world = updateSelectedBotMaxSpeed(world, selected, null);
    const cleared = getSelectedBot(world, selected);
    expect(cleared?.name).toBeUndefined();
    expect(cleared?.maxSpeed).toBeUndefined();
  });

  it('removing a spawn area unpins bots that referenced it', () => {
    let world = addSpawnAreaToWorld(emptyWorld()).world;
    const areaId = world.spawnAreas[0]!.id;
    const botAdd = addBotToWorld(world);
    world = botAdd.world;
    const botSelected = botAdd.selected as SelectedTarget;
    world = updateSelectedBotSpawnArea(world, botSelected, areaId);

    world = removeSelectedTargetFromWorld(world, { kind: 'spawnArea', id: areaId });
    const bot = world.bots[0];
    expect(bot?.spawnAreaId).toBeNull();
  });

  it('parses world documents missing bots or allowedKinds with defaults', () => {
    const raw = {
      version: 1,
      meta: { name: 'Legacy', description: '' },
      terrain: DEFAULT_WORLD_DOCUMENT.terrain,
      staticProps: [],
      dynamicEntities: [],
      spawnAreas: [{ id: 1, position: [0, 0, 0], radius: 10 }],
      // intentionally missing `bots`
    };
    const parsed = parseWorldDocument(raw);
    expect(parsed.bots).toEqual([]);
    expect(parsed.spawnAreas[0]?.allowedKinds).toEqual(['human', 'bot']);
  });
});
