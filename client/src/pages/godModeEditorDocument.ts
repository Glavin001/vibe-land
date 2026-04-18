import {
  cloneWorldDocument,
  DEFAULT_ALLOWED_KINDS,
  getMinimumDynamicEntityY,
  getNextBotId,
  getNextWorldEntityId,
  getNextSpawnAreaId,
  identityQuaternion,
  sampleTerrainHeightAtWorldPosition,
  type DynamicEntity,
  type PlayerKind,
  type PreconfiguredBot,
  type PreconfiguredBotBehavior,
  type Quaternion,
  type SpawnArea,
  type StaticProp,
  type Vec3,
  type WorldDocument,
} from '../world/worldDocument';
import { getSharedVehicleTypeByKey } from '../wasm/sharedVehicleDefinitions';

const DEFAULT_EDITOR_VEHICLE_TYPE = getSharedVehicleTypeByKey('cybertruck') ?? 0;

export type SelectedTarget =
  | { kind: 'static'; id: number }
  | { kind: 'dynamic'; id: number }
  | { kind: 'spawnArea'; id: number }
  | { kind: 'bot'; id: number }
  | null;

export type SelectedTransformEntity = {
  kind: 'static' | 'dynamic' | 'spawnArea';
  id: number;
  position: Vec3;
  rotation: Quaternion;
  halfExtents?: Vec3;
  radius?: number;
  canRotate: boolean;
  canResize: boolean;
};

export function selectionExists(world: WorldDocument, selected: SelectedTarget): boolean {
  if (!selected) {
    return false;
  }
  if (selected.kind === 'static') {
    return world.staticProps.some((entity) => entity.id === selected.id);
  }
  if (selected.kind === 'dynamic') {
    return world.dynamicEntities.some((entity) => entity.id === selected.id);
  }
  if (selected.kind === 'bot') {
    return world.bots.some((bot) => bot.id === selected.id);
  }
  return world.spawnAreas.some((area) => area.id === selected.id);
}

export function getSelectedStatic(world: WorldDocument, selected: SelectedTarget): StaticProp | null {
  if (selected?.kind !== 'static') {
    return null;
  }
  return world.staticProps.find((entity) => entity.id === selected.id) ?? null;
}

export function getSelectedDynamic(world: WorldDocument, selected: SelectedTarget): DynamicEntity | null {
  if (selected?.kind !== 'dynamic') {
    return null;
  }
  return world.dynamicEntities.find((entity) => entity.id === selected.id) ?? null;
}

export function getSelectedSpawnArea(world: WorldDocument, selected: SelectedTarget): SpawnArea | null {
  if (selected?.kind !== 'spawnArea') {
    return null;
  }
  return world.spawnAreas.find((area) => area.id === selected.id) ?? null;
}

export function getSelectedBot(world: WorldDocument, selected: SelectedTarget): PreconfiguredBot | null {
  if (selected?.kind !== 'bot') {
    return null;
  }
  return world.bots.find((bot) => bot.id === selected.id) ?? null;
}

export function resolveSelectedTransformEntity(
  world: WorldDocument,
  selected: SelectedTarget,
): SelectedTransformEntity | null {
  const selectedStatic = getSelectedStatic(world, selected);
  if (selectedStatic) {
    return {
      kind: 'static',
      id: selectedStatic.id,
      position: selectedStatic.position,
      rotation: selectedStatic.rotation,
      halfExtents: selectedStatic.halfExtents,
      canRotate: true,
      canResize: true,
    };
  }

  const selectedDynamic = getSelectedDynamic(world, selected);
  if (selectedDynamic) {
    return {
      kind: 'dynamic',
      id: selectedDynamic.id,
      position: selectedDynamic.position,
      rotation: selectedDynamic.rotation,
      halfExtents: selectedDynamic.halfExtents,
      radius: selectedDynamic.radius,
      canRotate: selectedDynamic.kind !== 'ball',
      canResize: selectedDynamic.kind !== 'vehicle',
    };
  }

  const selectedSpawnArea = getSelectedSpawnArea(world, selected);
  if (selectedSpawnArea) {
    return {
      kind: 'spawnArea',
      id: selectedSpawnArea.id,
      position: selectedSpawnArea.position,
      rotation: identityQuaternion(),
      radius: selectedSpawnArea.radius,
      canRotate: false,
      canResize: true,
    };
  }

  return null;
}

export function addStaticCuboidToWorld(
  current: WorldDocument,
): { world: WorldDocument; selected: SelectedTarget } {
  const nextId = getNextWorldEntityId(current);
  const baseY = sampleTerrainHeightAtWorldPosition(current, 0, 0) + 1;
  const nextStatic: StaticProp = {
    id: nextId,
    kind: 'cuboid',
    position: [0, baseY, 0],
    rotation: identityQuaternion(),
    halfExtents: [2, 1, 2],
    material: 'editor-static',
  };
  return {
    world: {
      ...current,
      staticProps: [...current.staticProps, nextStatic],
    },
    selected: { kind: 'static', id: nextId },
  };
}

export function addDynamicEntityToWorld(
  current: WorldDocument,
  kind: DynamicEntity['kind'],
): { world: WorldDocument; selected: SelectedTarget } {
  const nextId = getNextWorldEntityId(current);
  const common = {
    id: nextId,
    kind,
    position: [0, 0, 0] as [number, number, number],
    rotation: identityQuaternion() as Quaternion,
  };
  const entity: DynamicEntity = kind === 'box'
    ? { ...common, halfExtents: [0.7, 0.7, 0.7] }
    : kind === 'ball'
      ? { ...common, radius: 0.6 }
      : { ...common, vehicleType: DEFAULT_EDITOR_VEHICLE_TYPE };
  entity.position = [0, getMinimumDynamicEntityY(current, entity), 0];

  return {
    world: {
      ...current,
      dynamicEntities: [...current.dynamicEntities, entity],
    },
    selected: { kind: 'dynamic', id: nextId },
  };
}

export function addSpawnAreaToWorld(
  current: WorldDocument,
): { world: WorldDocument; selected: SelectedTarget } {
  const nextId = getNextSpawnAreaId(current);
  const baseY = sampleTerrainHeightAtWorldPosition(current, 0, 0);
  const area: SpawnArea = {
    id: nextId,
    position: [0, baseY, 0],
    radius: 10,
    allowedKinds: [...DEFAULT_ALLOWED_KINDS],
  };
  return {
    world: {
      ...current,
      spawnAreas: [...current.spawnAreas, area],
    },
    selected: { kind: 'spawnArea', id: nextId },
  };
}

export function addBotToWorld(
  current: WorldDocument,
): { world: WorldDocument; selected: SelectedTarget } {
  const nextId = getNextBotId(current);
  const bot: PreconfiguredBot = {
    id: nextId,
    behavior: 'harass',
    spawnAreaId: null,
  };
  return {
    world: {
      ...current,
      bots: [...current.bots, bot],
    },
    selected: { kind: 'bot', id: nextId },
  };
}

export function removeSelectedTargetFromWorld(
  current: WorldDocument,
  selected: SelectedTarget,
): WorldDocument {
  if (!selected) {
    return current;
  }
  if (selected.kind === 'static') {
    return {
      ...current,
      staticProps: current.staticProps.filter((entity) => entity.id !== selected.id),
    };
  }
  if (selected.kind === 'spawnArea') {
    return {
      ...current,
      spawnAreas: current.spawnAreas.filter((area) => area.id !== selected.id),
      // Unpin bots that referenced the deleted area.
      bots: current.bots.map((bot) => (
        bot.spawnAreaId === selected.id ? { ...bot, spawnAreaId: null } : bot
      )),
    };
  }
  if (selected.kind === 'bot') {
    return {
      ...current,
      bots: current.bots.filter((bot) => bot.id !== selected.id),
    };
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.filter((entity) => entity.id !== selected.id),
  };
}

export function updateSelectedTargetPosition(
  current: WorldDocument,
  selected: SelectedTarget,
  nextPosition: Vec3,
): WorldDocument {
  if (!selected) {
    return current;
  }
  if (selected.kind === 'static') {
    return {
      ...current,
      staticProps: current.staticProps.map((entity) => (
        entity.id === selected.id
          ? { ...entity, position: nextPosition }
          : entity
      )),
    };
  }
  if (selected.kind === 'spawnArea') {
    return {
      ...current,
      spawnAreas: current.spawnAreas.map((area) => (
        area.id === selected.id
          ? { ...area, position: nextPosition }
          : area
      )),
    };
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.map((entity) => (
      entity.id === selected.id
        ? { ...entity, position: nextPosition }
        : entity
    )),
  };
}

export function updateSelectedTargetHalfExtents(
  current: WorldDocument,
  selected: SelectedTarget,
  nextHalfExtents: Vec3,
): WorldDocument {
  if (!selected) {
    return current;
  }
  if (selected.kind === 'static') {
    return {
      ...current,
      staticProps: current.staticProps.map((entity) => (
        entity.id === selected.id
          ? { ...entity, halfExtents: nextHalfExtents }
          : entity
      )),
    };
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.map((entity) => (
      entity.id === selected.id && entity.halfExtents
        ? { ...entity, halfExtents: nextHalfExtents }
        : entity
    )),
  };
}

export function updateSelectedTargetRadius(
  current: WorldDocument,
  selected: SelectedTarget,
  nextRadius: number,
): WorldDocument {
  if (selected?.kind === 'dynamic') {
    return {
      ...current,
      dynamicEntities: current.dynamicEntities.map((entity) => (
        entity.id === selected.id
          ? { ...entity, radius: nextRadius }
          : entity
      )),
    };
  }
  if (selected?.kind === 'spawnArea') {
    return {
      ...current,
      spawnAreas: current.spawnAreas.map((area) => (
        area.id === selected.id
          ? { ...area, radius: Math.max(1, nextRadius) }
          : area
      )),
    };
  }
  return current;
}

export function updateSelectedTargetVehicleType(
  current: WorldDocument,
  selected: SelectedTarget,
  nextVehicleType: number,
): WorldDocument {
  if (selected?.kind !== 'dynamic') {
    return current;
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.map((entity) => {
      if (entity.id !== selected.id || entity.kind !== 'vehicle') {
        return entity;
      }
      const nextEntity: DynamicEntity = {
        ...entity,
        vehicleType: Math.trunc(nextVehicleType),
      };
      const minY = getMinimumDynamicEntityY(current, nextEntity);
      return {
        ...nextEntity,
        position: [
          nextEntity.position[0],
          Math.max(nextEntity.position[1], minY),
          nextEntity.position[2],
        ],
      };
    }),
  };
}

export function updateSelectedTargetRotation(
  current: WorldDocument,
  selected: SelectedTarget,
  nextRotation: Quaternion,
): WorldDocument {
  if (!selected) {
    return current;
  }
  if (selected.kind === 'static') {
    return {
      ...current,
      staticProps: current.staticProps.map((entity) => (
        entity.id === selected.id
          ? { ...entity, rotation: nextRotation }
          : entity
      )),
    };
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.map((entity) => (
      entity.id === selected.id
        ? { ...entity, rotation: nextRotation }
        : entity
    )),
  };
}

export function updateSpawnAreaAllowedKind(
  current: WorldDocument,
  selected: SelectedTarget,
  kind: PlayerKind,
  enabled: boolean,
): WorldDocument {
  if (selected?.kind !== 'spawnArea') {
    return current;
  }
  return {
    ...current,
    spawnAreas: current.spawnAreas.map((area) => {
      if (area.id !== selected.id) return area;
      const next = new Set(area.allowedKinds);
      if (enabled) {
        next.add(kind);
      } else {
        next.delete(kind);
      }
      // Enforce at least one allowed kind.
      if (next.size === 0) {
        return area;
      }
      // Preserve stable ordering.
      const ordered = (['human', 'bot'] as PlayerKind[]).filter((k) => next.has(k));
      return { ...area, allowedKinds: ordered };
    }),
  };
}

export function updateSelectedBotBehavior(
  current: WorldDocument,
  selected: SelectedTarget,
  behavior: PreconfiguredBotBehavior,
): WorldDocument {
  if (selected?.kind !== 'bot') {
    return current;
  }
  return {
    ...current,
    bots: current.bots.map((bot) => (
      bot.id === selected.id ? { ...bot, behavior } : bot
    )),
  };
}

export function updateSelectedBotName(
  current: WorldDocument,
  selected: SelectedTarget,
  name: string,
): WorldDocument {
  if (selected?.kind !== 'bot') {
    return current;
  }
  const trimmed = name.trim();
  return {
    ...current,
    bots: current.bots.map((bot) => {
      if (bot.id !== selected.id) return bot;
      const next = { ...bot };
      if (trimmed.length === 0) {
        delete next.name;
      } else {
        next.name = trimmed;
      }
      return next;
    }),
  };
}

export function updateSelectedBotMaxSpeed(
  current: WorldDocument,
  selected: SelectedTarget,
  maxSpeed: number | null,
): WorldDocument {
  if (selected?.kind !== 'bot') {
    return current;
  }
  return {
    ...current,
    bots: current.bots.map((bot) => {
      if (bot.id !== selected.id) return bot;
      const next = { ...bot };
      if (maxSpeed === null || !Number.isFinite(maxSpeed)) {
        delete next.maxSpeed;
      } else {
        next.maxSpeed = Math.max(0.5, Math.min(12, maxSpeed));
      }
      return next;
    }),
  };
}

export function updateSelectedBotSpawnArea(
  current: WorldDocument,
  selected: SelectedTarget,
  spawnAreaId: number | null,
): WorldDocument {
  if (selected?.kind !== 'bot') {
    return current;
  }
  return {
    ...current,
    bots: current.bots.map((bot) => (
      bot.id === selected.id ? { ...bot, spawnAreaId } : bot
    )),
  };
}

export function clonePlayWorldSnapshot(world: WorldDocument): WorldDocument {
  return cloneWorldDocument(world);
}
