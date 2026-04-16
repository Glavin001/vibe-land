import {
  addTerrainTile,
  applyTerrainBrush,
  applyTerrainNoiseBrush,
  applyTerrainRampStencil,
  carveTerrainSpline,
  cloneWorldDocument,
  flattenTerrainBrush,
  getAddableTerrainTiles,
  getNextWorldEntityId,
  getTerrainRegionStats,
  getTerrainTile,
  getTerrainTileBounds,
  getTerrainTileCenter,
  getTerrainWorldBounds,
  identityQuaternion,
  quaternionFromYaw,
  removeTerrainTile,
  sampleTerrainHeightAtWorldPosition,
  sampleTerrainHeightGrid,
  smoothTerrainBrush,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type TerrainRampStencil,
  type Vec3,
  type WorldDocument,
} from '../world/worldDocument';
import { applyCustomStencilToWorld, type CustomStencilDefinition } from './customStencil';
import { getStencil, registerStencil } from './customStencilStore';

export type WorldEditUpdater = (current: WorldDocument) => WorldDocument;

export type WorldEditOptions = { isAiEdit?: boolean };

export type WorldAccessors = {
  getWorld: () => WorldDocument;
  commitEdit: (updater: WorldEditUpdater, options?: WorldEditOptions) => boolean;
};

type TerrainMutationStats = {
  samplesAffected: number;
  deltaMin: number;
  deltaMax: number;
  heightMin: number;
  heightMax: number;
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
  getTerrainTileBounds(tileX: number, tileZ: number): { minX: number; maxX: number; minZ: number; maxZ: number };
  getTerrainTileCenter(tileX: number, tileZ: number): { x: number; z: number };
  sampleTerrainHeight(x: number, z: number): number;
  getAddableTerrainTiles(): Array<{ tileX: number; tileZ: number }>;
  getTerrainRegionStats(spec: {
    centerX: number;
    centerZ: number;
    radius: number;
  }): { sampleCount: number; minHeight: number; maxHeight: number; avgHeight: number; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } };
  sampleTerrainGrid(spec: {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
    step: number;
  }): Array<{ x: number; z: number; height: number }>;
  nextEntityId(): number;

  // ---- ENTITY SEARCH ----
  findEntitiesInRadius(spec: {
    x: number;
    z: number;
    radius: number;
    y?: number;
    yRadius?: number;
  }): Array<{ kind: 'static' | 'dynamic'; entity: StaticProp | DynamicEntity }>;
  findEntitiesInBox(spec: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    minY?: number;
    maxY?: number;
  }): Array<{ kind: 'static' | 'dynamic'; entity: StaticProp | DynamicEntity }>;

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
  }): { changed: boolean } & Partial<TerrainMutationStats>;
  applyTerrainRamp(stencil: TerrainRampStencil): { changed: boolean };
  flattenTerrain(spec: {
    centerX: number;
    centerZ: number;
    radius: number;
    targetHeight: number;
    strength: number;
  }): { changed: boolean } & Partial<TerrainMutationStats>;
  smoothTerrain(spec: {
    centerX: number;
    centerZ: number;
    radius: number;
    strength: number;
  }): { changed: boolean } & Partial<TerrainMutationStats>;
  applyTerrainNoise(spec: {
    centerX: number;
    centerZ: number;
    radius: number;
    amplitude: number;
    scale: number;
    octaves?: number;
    seed?: number;
  }): { changed: boolean } & Partial<TerrainMutationStats>;
  carveSpline(spec: {
    points: Array<{ x: number; z: number }>;
    width: number;
    falloffM: number;
    mode: 'lower' | 'raise' | 'flatten';
    strength: number;
    targetHeight?: number;
  }): { changed: boolean } & Partial<TerrainMutationStats>;
  addTerrainTile(tileX: number, tileZ: number): { changed: boolean };
  removeTerrainTile(tileX: number, tileZ: number): { changed: boolean };

  // ---- CUSTOM STENCILS ----
  registerCustomStencil(definition: CustomStencilDefinition): { registered: boolean; error?: string };
  applyCustomStencil(
    stencilId: string,
    centerX: number,
    centerZ: number,
    params?: Record<string, unknown>,
  ): { changed: boolean; error?: string } & Partial<TerrainMutationStats>;

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
    getTerrainTileBounds(tileX, tileZ) {
      return getTerrainTileBounds(accessors.getWorld(), tileX, tileZ);
    },
    getTerrainTileCenter(tileX, tileZ) {
      const [x, z] = getTerrainTileCenter(accessors.getWorld(), tileX, tileZ);
      return { x, z };
    },
    sampleTerrainHeight(x, z) {
      return sampleTerrainHeightAtWorldPosition(accessors.getWorld(), x, z);
    },
    getAddableTerrainTiles() {
      return getAddableTerrainTiles(accessors.getWorld()).map(({ tileX, tileZ }) => ({ tileX, tileZ }));
    },
    getTerrainRegionStats(spec) {
      return getTerrainRegionStats(accessors.getWorld(), spec.centerX, spec.centerZ, spec.radius);
    },
    sampleTerrainGrid(spec) {
      return sampleTerrainHeightGrid(accessors.getWorld(), spec.minX, spec.minZ, spec.maxX, spec.maxZ, spec.step);
    },
    nextEntityId() {
      return getNextWorldEntityId(accessors.getWorld());
    },

    findEntitiesInRadius(spec) {
      const world = accessors.getWorld();
      const { x, z, radius, y, yRadius } = spec;
      const results: Array<{ kind: 'static' | 'dynamic'; entity: StaticProp | DynamicEntity }> = [];
      for (const entity of world.staticProps) {
        if (Math.hypot(entity.position[0] - x, entity.position[2] - z) > radius) continue;
        if (typeof y === 'number' && typeof yRadius === 'number') {
          if (Math.abs(entity.position[1] - y) > yRadius) continue;
        }
        results.push({ kind: 'static', entity: cloneJson(entity) });
      }
      for (const entity of world.dynamicEntities) {
        if (Math.hypot(entity.position[0] - x, entity.position[2] - z) > radius) continue;
        if (typeof y === 'number' && typeof yRadius === 'number') {
          if (Math.abs(entity.position[1] - y) > yRadius) continue;
        }
        results.push({ kind: 'dynamic', entity: cloneJson(entity) });
      }
      return results;
    },
    findEntitiesInBox(spec) {
      const world = accessors.getWorld();
      const { minX, maxX, minZ, maxZ, minY, maxY } = spec;
      const results: Array<{ kind: 'static' | 'dynamic'; entity: StaticProp | DynamicEntity }> = [];
      function inBox(pos: Vec3): boolean {
        if (pos[0] < minX || pos[0] > maxX) return false;
        if (pos[2] < minZ || pos[2] > maxZ) return false;
        if (typeof minY === 'number' && pos[1] < minY) return false;
        if (typeof maxY === 'number' && pos[1] > maxY) return false;
        return true;
      }
      for (const entity of world.staticProps) {
        if (inBox(entity.position)) results.push({ kind: 'static', entity: cloneJson(entity) });
      }
      for (const entity of world.dynamicEntities) {
        if (inBox(entity.position)) results.push({ kind: 'dynamic', entity: cloneJson(entity) });
      }
      return results;
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
      const before = accessors.getWorld();
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
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    applyTerrainRamp(stencil) {
      if (!stencil || typeof stencil !== 'object') {
        return { changed: false };
      }
      const changed = aiEdit((current) => applyTerrainRampStencil(current, stencil));
      return { changed };
    },

    flattenTerrain(spec) {
      if (typeof spec?.centerX !== 'number' || typeof spec?.centerZ !== 'number') {
        return { changed: false };
      }
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        flattenTerrainBrush(current, spec.centerX, spec.centerZ, spec.radius, spec.targetHeight, spec.strength),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    smoothTerrain(spec) {
      if (typeof spec?.centerX !== 'number' || typeof spec?.centerZ !== 'number') {
        return { changed: false };
      }
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        smoothTerrainBrush(current, spec.centerX, spec.centerZ, spec.radius, spec.strength),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    applyTerrainNoise(spec) {
      if (typeof spec?.centerX !== 'number' || typeof spec?.centerZ !== 'number') {
        return { changed: false };
      }
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        applyTerrainNoiseBrush(
          current,
          spec.centerX,
          spec.centerZ,
          spec.radius,
          spec.amplitude,
          spec.scale,
          spec.octaves ?? 4,
          spec.seed ?? 42,
        ),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    carveSpline(spec) {
      if (!Array.isArray(spec?.points) || spec.points.length < 2) {
        return { changed: false };
      }
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        carveTerrainSpline(current, spec.points, spec.width, spec.falloffM, spec.mode, spec.strength, spec.targetHeight),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    addTerrainTile(tileX, tileZ) {
      const changed = aiEdit((current) => addTerrainTile(current, tileX, tileZ));
      return { changed };
    },

    removeTerrainTile(tileX, tileZ) {
      const changed = aiEdit((current) => removeTerrainTile(current, tileX, tileZ));
      return { changed };
    },

    registerCustomStencil(definition) {
      return registerStencil(definition);
    },

    applyCustomStencil(stencilId, centerX, centerZ, params) {
      const stencilDef = getStencil(stencilId);
      if (!stencilDef) return { changed: false, error: `no custom stencil with id "${stencilId}"` };
      const mergedParams = { ...stencilDef.defaultParams, ...params };
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        applyCustomStencilToWorld(current, stencilDef, mergedParams, centerX, centerZ),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
    },

    quaternionFromYaw(yawRad) {
      return quaternionFromYaw(yawRad);
    },
    identityQuaternion() {
      return identityQuaternion();
    },
  };
}

function computeTerrainMutationStats(before: WorldDocument, after: WorldDocument): TerrainMutationStats {
  let samplesAffected = 0;
  let deltaMin = Number.POSITIVE_INFINITY;
  let deltaMax = Number.NEGATIVE_INFINITY;
  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;

  for (const afterTile of after.terrain.tiles) {
    const beforeTile = before.terrain.tiles.find(
      (t) => t.tileX === afterTile.tileX && t.tileZ === afterTile.tileZ,
    );
    // Reference equality: unchanged tiles share the same object in copy-on-write pattern
    if (!beforeTile || beforeTile === afterTile) continue;
    for (let i = 0; i < afterTile.heights.length; i += 1) {
      const prev = beforeTile.heights[i] ?? 0;
      const next = afterTile.heights[i] ?? 0;
      const delta = next - prev;
      if (Math.abs(delta) > 1e-7) {
        samplesAffected += 1;
        if (delta < deltaMin) deltaMin = delta;
        if (delta > deltaMax) deltaMax = delta;
      }
      if (next < heightMin) heightMin = next;
      if (next > heightMax) heightMax = next;
    }
  }

  if (samplesAffected === 0) {
    return { samplesAffected: 0, deltaMin: 0, deltaMax: 0, heightMin: 0, heightMax: 0 };
  }
  return { samplesAffected, deltaMin, deltaMax, heightMin, heightMax };
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
