import {
  addTerrainTile,
  applyTerrainBrush,
  applyTerrainRampStencil,
  cloneWorldDocument,
  getAddableTerrainTiles,
  getNextWorldEntityId,
  getTerrainTile,
  getTerrainWorldBounds,
  identityQuaternion,
  quaternionFromYaw,
  removeTerrainTile,
  sampleTerrainHeightAtWorldPosition,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type TerrainRampStencil,
  type Vec3,
  type WorldDocument,
} from '../world/worldDocument';

export type WorldEditUpdater = (current: WorldDocument) => WorldDocument;

export type WorldEditOptions = { isAiEdit?: boolean };

export type WorldAccessors = {
  getWorld: () => WorldDocument;
  commitEdit: (updater: WorldEditUpdater, options?: WorldEditOptions) => boolean;
};

export type WorldCtx = {
  // ---- READ ----
  getWorld(): WorldDocument;
  getMeta(): { name: string; description: string };
  listStaticProps(): StaticProp[];
  listDynamicEntities(): DynamicEntity[];
  getEntity(id: number): { kind: 'static'; entity: StaticProp } | { kind: 'dynamic'; entity: DynamicEntity } | null;
  getTerrainInfo(): {
    tileGridSize: number;
    tileHalfExtentM: number;
    tileCount: number;
    bounds: ReturnType<typeof getTerrainWorldBounds>;
  };
  listTerrainTiles(): Array<{ tileX: number; tileZ: number }>;
  getTerrainTile(tileX: number, tileZ: number): {
    tileX: number;
    tileZ: number;
    heights: number[];
  } | null;
  sampleTerrainHeight(x: number, z: number): number;
  getAddableTerrainTiles(): Array<{ tileX: number; tileZ: number }>;
  nextEntityId(): number;

  // ---- WRITE ----
  addStaticCuboid(spec: {
    position: Vec3;
    halfExtents: Vec3;
    rotation?: Quaternion;
    material?: string;
  }): { changed: boolean; id?: number; reason?: string };
  addDynamicEntity(spec: {
    kind: 'box' | 'ball' | 'vehicle';
    position: Vec3;
    rotation?: Quaternion;
    halfExtents?: Vec3;
    radius?: number;
    vehicleType?: number;
  }): { changed: boolean; id?: number; reason?: string };
  removeEntity(id: number): { changed: boolean; reason?: string };
  updateEntity(
    id: number,
    patch: Partial<{
      position: Vec3;
      rotation: Quaternion;
      halfExtents: Vec3;
      radius: number;
    }>,
  ): { changed: boolean; reason?: string };

  applyTerrainBrush(spec: {
    centerX: number;
    centerZ: number;
    radius: number;
    strength: number;
    mode: 'raise' | 'lower';
    minHeight?: number;
    maxHeight?: number;
  }): { changed: boolean };
  applyTerrainRamp(stencil: TerrainRampStencil): { changed: boolean };
  addTerrainTile(tileX: number, tileZ: number): { changed: boolean };
  removeTerrainTile(tileX: number, tileZ: number): { changed: boolean };

  // ---- MATH ----
  quaternionFromYaw(yawRad: number): Quaternion;
  identityQuaternion(): Quaternion;
};

/**
 * Build a fresh `ctx` object for one tool invocation. The accessors are bound
 * once; helpers always read live world state via `accessors.getWorld()` so that
 * sequential calls within the same `executeUserCode` invocation see each
 * other's mutations.
 */
export function buildWorldCtx(accessors: WorldAccessors): WorldCtx {
  const aiEdit = (updater: WorldEditUpdater): boolean =>
    accessors.commitEdit(updater, { isAiEdit: true });

  function findEntityWithKind(id: number): { kind: 'static' | 'dynamic'; entity: StaticProp | DynamicEntity } | null {
    const world = accessors.getWorld();
    const staticEntity = world.staticProps.find((e) => e.id === id);
    if (staticEntity) return { kind: 'static', entity: staticEntity };
    const dynamicEntity = world.dynamicEntities.find((e) => e.id === id);
    if (dynamicEntity) return { kind: 'dynamic', entity: dynamicEntity };
    return null;
  }

  return {
    getWorld(): WorldDocument {
      return cloneWorldDocument(accessors.getWorld());
    },
    getMeta() {
      const world = accessors.getWorld();
      return { name: world.meta.name, description: world.meta.description };
    },
    listStaticProps() {
      return cloneArray(accessors.getWorld().staticProps);
    },
    listDynamicEntities() {
      return cloneArray(accessors.getWorld().dynamicEntities);
    },
    getEntity(id) {
      const found = findEntityWithKind(id);
      if (!found) return null;
      if (found.kind === 'static') {
        return { kind: 'static', entity: cloneJson(found.entity as StaticProp) };
      }
      return { kind: 'dynamic', entity: cloneJson(found.entity as DynamicEntity) };
    },
    getTerrainInfo() {
      const world = accessors.getWorld();
      return {
        tileGridSize: world.terrain.tileGridSize,
        tileHalfExtentM: world.terrain.tileHalfExtentM,
        tileCount: world.terrain.tiles.length,
        bounds: getTerrainWorldBounds(world),
      };
    },
    listTerrainTiles() {
      return accessors.getWorld().terrain.tiles.map((tile) => ({
        tileX: tile.tileX,
        tileZ: tile.tileZ,
      }));
    },
    getTerrainTile(tileX, tileZ) {
      const tile = getTerrainTile(accessors.getWorld(), tileX, tileZ);
      if (!tile) return null;
      return { tileX: tile.tileX, tileZ: tile.tileZ, heights: [...tile.heights] };
    },
    sampleTerrainHeight(x, z) {
      return sampleTerrainHeightAtWorldPosition(accessors.getWorld(), x, z);
    },
    getAddableTerrainTiles() {
      return getAddableTerrainTiles(accessors.getWorld()).map(({ tileX, tileZ }) => ({ tileX, tileZ }));
    },
    nextEntityId() {
      return getNextWorldEntityId(accessors.getWorld());
    },

    addStaticCuboid(spec) {
      const validation = validateVec3('position', spec.position) ?? validateVec3('halfExtents', spec.halfExtents);
      if (validation) return { changed: false, reason: validation };
      let assignedId = 0;
      const changed = aiEdit((current) => {
        const id = getNextWorldEntityId(current);
        assignedId = id;
        const next: StaticProp = {
          id,
          kind: 'cuboid',
          position: [...spec.position] as Vec3,
          halfExtents: [...spec.halfExtents] as Vec3,
          rotation: spec.rotation ? ([...spec.rotation] as Quaternion) : identityQuaternion(),
          ...(spec.material ? { material: spec.material } : {}),
        };
        return { ...current, staticProps: [...current.staticProps, next] };
      });
      return changed ? { changed, id: assignedId } : { changed };
    },

    addDynamicEntity(spec) {
      if (spec.kind !== 'box' && spec.kind !== 'ball' && spec.kind !== 'vehicle') {
        return { changed: false, reason: `unknown kind: ${String(spec.kind)}` };
      }
      const positionError = validateVec3('position', spec.position);
      if (positionError) return { changed: false, reason: positionError };
      if (spec.kind === 'box' && !spec.halfExtents) {
        return { changed: false, reason: 'box requires halfExtents' };
      }
      if (spec.kind === 'ball' && typeof spec.radius !== 'number') {
        return { changed: false, reason: 'ball requires radius' };
      }
      let assignedId = 0;
      const changed = aiEdit((current) => {
        const id = getNextWorldEntityId(current);
        assignedId = id;
        const next: DynamicEntity = {
          id,
          kind: spec.kind,
          position: [...spec.position] as Vec3,
          rotation: spec.rotation ? ([...spec.rotation] as Quaternion) : identityQuaternion(),
          ...(spec.halfExtents ? { halfExtents: [...spec.halfExtents] as Vec3 } : {}),
          ...(typeof spec.radius === 'number' ? { radius: spec.radius } : {}),
          ...(typeof spec.vehicleType === 'number' ? { vehicleType: spec.vehicleType } : {}),
        };
        return { ...current, dynamicEntities: [...current.dynamicEntities, next] };
      });
      return changed ? { changed, id: assignedId } : { changed };
    },

    removeEntity(id) {
      const found = findEntityWithKind(id);
      if (!found) return { changed: false, reason: `no entity with id ${id}` };
      const changed = aiEdit((current) => {
        if (found.kind === 'static') {
          return { ...current, staticProps: current.staticProps.filter((e) => e.id !== id) };
        }
        return { ...current, dynamicEntities: current.dynamicEntities.filter((e) => e.id !== id) };
      });
      return { changed };
    },

    updateEntity(id, patch) {
      if (!patch || typeof patch !== 'object') {
        return { changed: false, reason: 'patch must be an object' };
      }
      if (patch.position) {
        const err = validateVec3('position', patch.position);
        if (err) return { changed: false, reason: err };
      }
      if (patch.halfExtents) {
        const err = validateVec3('halfExtents', patch.halfExtents);
        if (err) return { changed: false, reason: err };
      }
      const found = findEntityWithKind(id);
      if (!found) return { changed: false, reason: `no entity with id ${id}` };

      const changed = aiEdit((current) => {
        if (found.kind === 'static') {
          const idx = current.staticProps.findIndex((e) => e.id === id);
          if (idx === -1) return current;
          const target = current.staticProps[idx];
          const updated: StaticProp = {
            ...target,
            ...(patch.position ? { position: [...patch.position] as Vec3 } : {}),
            ...(patch.rotation ? { rotation: [...patch.rotation] as Quaternion } : {}),
            ...(patch.halfExtents ? { halfExtents: [...patch.halfExtents] as Vec3 } : {}),
          };
          const nextProps = [...current.staticProps];
          nextProps[idx] = updated;
          return { ...current, staticProps: nextProps };
        }
        const idx = current.dynamicEntities.findIndex((e) => e.id === id);
        if (idx === -1) return current;
        const target = current.dynamicEntities[idx];
        const updated: DynamicEntity = {
          ...target,
          ...(patch.position ? { position: [...patch.position] as Vec3 } : {}),
          ...(patch.rotation ? { rotation: [...patch.rotation] as Quaternion } : {}),
          ...(patch.halfExtents ? { halfExtents: [...patch.halfExtents] as Vec3 } : {}),
          ...(typeof patch.radius === 'number' ? { radius: patch.radius } : {}),
        };
        const nextEntities = [...current.dynamicEntities];
        nextEntities[idx] = updated;
        return { ...current, dynamicEntities: nextEntities };
      });
      return { changed };
    },

    applyTerrainBrush(spec) {
      if (typeof spec?.centerX !== 'number' || typeof spec?.centerZ !== 'number') {
        return { changed: false };
      }
      const changed = aiEdit((current) =>
        applyTerrainBrush(
          current,
          spec.centerX,
          spec.centerZ,
          spec.radius,
          spec.strength,
          spec.mode,
          { minHeight: spec.minHeight, maxHeight: spec.maxHeight },
        ),
      );
      return { changed };
    },

    applyTerrainRamp(stencil) {
      if (!stencil || typeof stencil !== 'object') {
        return { changed: false };
      }
      const changed = aiEdit((current) => applyTerrainRampStencil(current, stencil));
      return { changed };
    },

    addTerrainTile(tileX, tileZ) {
      const changed = aiEdit((current) => addTerrainTile(current, tileX, tileZ));
      return { changed };
    },

    removeTerrainTile(tileX, tileZ) {
      const changed = aiEdit((current) => removeTerrainTile(current, tileX, tileZ));
      return { changed };
    },

    quaternionFromYaw(yawRad) {
      return quaternionFromYaw(yawRad);
    },
    identityQuaternion() {
      return identityQuaternion();
    },
  };
}

function validateVec3(name: string, value: unknown): string | null {
  if (
    !Array.isArray(value)
    || value.length !== 3
    || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  ) {
    return `${name} must be a [x, y, z] tuple of finite numbers`;
  }
  return null;
}

function cloneArray<T>(arr: readonly T[]): T[] {
  return arr.map((item) => cloneJson(item));
}

function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
