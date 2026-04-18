import {
  cloneWorldDocument,
  getMinimumDynamicEntityY,
  getNextWorldEntityId,
  identityQuaternion,
  sampleTerrainHeightAtWorldPosition,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type Vec3,
  type WorldDocument,
} from '../world/worldDocument';
import { getSharedVehicleTypeByKey } from '../wasm/sharedVehicleDefinitions';

const DEFAULT_EDITOR_VEHICLE_TYPE = getSharedVehicleTypeByKey('cybertruck') ?? 0;

export type SelectedTarget =
  | { kind: 'static'; id: number }
  | { kind: 'dynamic'; id: number }
  | null;

export type SelectedTransformEntity = {
  kind: 'static' | 'dynamic';
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
  return selected.kind === 'static'
    ? world.staticProps.some((entity) => entity.id === selected.id)
    : world.dynamicEntities.some((entity) => entity.id === selected.id);
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
  if (selected?.kind !== 'dynamic') {
    return current;
  }
  return {
    ...current,
    dynamicEntities: current.dynamicEntities.map((entity) => (
      entity.id === selected.id
        ? { ...entity, radius: nextRadius }
        : entity
    )),
  };
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

export function clonePlayWorldSnapshot(world: WorldDocument): WorldDocument {
  return cloneWorldDocument(world);
}
