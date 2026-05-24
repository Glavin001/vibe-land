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
  MAX_CHUNKS_PER_STRUCTURE,
  quaternionFromYaw,
  removeTerrainTile,
  sampleTerrainHeightAtWorldPosition,
  sampleTerrainHeightGrid,
  smoothTerrainBrush,
  type Chunk,
  type Destructible,
  type DynamicEntity,
  type Quaternion,
  type StaticProp,
  type StructureDestructible,
  type TerrainRampStencil,
  type Vec3,
  type WorldDocument,
} from '../world/worldDocument';
import { expandFactoryKindToChunks } from '../world/destructibleFactory';
import { applyCustomStencilToWorld, type CustomStencilDefinition } from './customStencil';
import { getStencil, registerStencil } from './customStencilStore';

import type { SplineData, SplinePoint } from './splineData';
import {
  computeSplineLength,
  sampleSplineAtDistance,
  tangentAtDistance as splineTangentAtDistance,
  normalAtDistance as splineNormalAtDistance,
  resampleSplineBySpacing,
  offsetSplineCurve,
  computeSplineBounds,
  findSplineSelfIntersections as findSelfIntersections,
  projectPointOntoSpline,
  buildArcLengthTable,
} from './splineMath';
import { deformTerrainAlongSpline as applyTerrainSplineDeform } from './terrainSplineDeform';
import { generateCommitId } from '../pages/godModeHistory';

export type WorldEditUpdater = (current: WorldDocument) => WorldDocument;

export type WorldEditOptions = { isAiEdit?: boolean };

export type WorldAccessors = {
  getWorld: () => WorldDocument;
  commitEdit: (updater: WorldEditUpdater, options?: WorldEditOptions) => boolean;
  // Internal methods for execute_js atomic execution:
  applyWithoutCommit: (updater: WorldEditUpdater) => boolean;
  restoreWorld: (snapshot: WorldDocument) => void;
  commitAsAi: (snapshotBefore: WorldDocument, commitId: string, commitMessage: string) => void;
  // For rollback tool:
  rollbackToCommit: (commitId: string) => { ok: boolean; message: string; commitId?: string };
  // For spline storage:
  getSplines: () => Map<string, SplineData>;
  setSpline: (id: string, spline: SplineData) => void;
  deleteSpline: (id: string) => boolean;
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

  // ---- DESTRUCTIBLES ----
  listDestructibles(): Destructible[];
  getDestructible(id: number): Destructible | null;
  addDestructibleStructure(spec: {
    position: Vec3;
    rotation?: Quaternion;
    density?: number;
    solverMaterialScale?: number;
    fractured?: boolean;
    chunks: Chunk[];
  }): { changed: boolean; id?: number; reason?: string };
  removeDestructible(id: number): { changed: boolean; reason?: string };
  updateDestructible(
    id: number,
    patch: Partial<{
      position: Vec3;
      rotation: Quaternion;
      density: number;
      solverMaterialScale: number;
      fractured: boolean;
    }>,
  ): { changed: boolean; reason?: string };
  addChunk(
    structureId: number,
    chunk: Chunk,
  ): { changed: boolean; chunkIndex?: number; reason?: string };
  updateChunk(
    structureId: number,
    chunkIndex: number,
    patch: Partial<Chunk>,
  ): { changed: boolean; reason?: string };
  removeChunk(
    structureId: number,
    chunkIndex: number,
  ): { changed: boolean; reason?: string };
  duplicateChunk(
    structureId: number,
    chunkIndex: number,
    offset?: Vec3,
  ): { changed: boolean; chunkIndex?: number; reason?: string };
  convertFactoryToStructure(id: number): { changed: boolean; reason?: string };

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

  deformTerrainAlongSpline(spec: {
    splineId: string;
    profile: Array<{ u: number; y: number }>;
    mode?: 'absolute' | 'relative';
    applyMode?: 'blend' | 'raiseOnly' | 'lowerOnly';
    strength?: number;
    falloff?: number;
    sampleSpacing?: number;
  }): { changed: boolean } & Partial<TerrainMutationStats>;

  // ---- CUSTOM STENCILS ----
  registerCustomStencil(definition: CustomStencilDefinition): { registered: boolean; error?: string };
  applyCustomStencil(
    stencilId: string,
    centerX: number,
    centerZ: number,
    params?: Record<string, unknown>,
  ): { changed: boolean; error?: string } & Partial<TerrainMutationStats>;

  // ---- SPLINE CRUD ----
  createSpline(spec: {
    points: SplinePoint[];
    closed?: boolean;
    interpolation?: 'polyline' | 'catmull-rom';
    tension?: number;
    name?: string;
  }): { id: string };
  getSpline(id: string): SplineData | null;
  updateSpline(id: string, patch: Partial<Omit<SplineData, 'id'>>): { changed: boolean };
  deleteSpline(id: string): { changed: boolean };
  listSplines(): SplineData[];

  // ---- SPLINE MATH ----
  splineLength(id: string): number | null;
  sampleSpline(id: string, opts: { count?: number; spacing?: number; distances?: number[] }): SplinePoint[] | null;
  splineTangent(id: string, distance: number): SplinePoint | null;
  splineNormal(id: string, distance: number): SplinePoint | null;
  splineBounds(id: string): { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  resampleSpline(id: string, spacing: number): SplinePoint[] | null;
  offsetSpline(id: string, offset: number, spacing?: number): SplinePoint[] | null;
  findSplineSelfIntersections(id: string): SplinePoint[] | null;
  projectOntoSpline(id: string, point: SplinePoint): { along: number; across: number } | null;

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

    // ---- DESTRUCTIBLES ----
    listDestructibles() {
      return cloneArray(accessors.getWorld().destructibles);
    },

    getDestructible(id) {
      const found = accessors.getWorld().destructibles.find((d) => d.id === id);
      return found ? cloneJson(found) : null;
    },

    addDestructibleStructure(spec) {
      if (!spec || typeof spec !== 'object') {
        return { changed: false, reason: 'spec must be an object' };
      }
      const positionErr = validateVec3('position', spec.position);
      if (positionErr) return { changed: false, reason: positionErr };
      if (!Array.isArray(spec.chunks) || spec.chunks.length === 0) {
        return { changed: false, reason: 'chunks must be a non-empty array' };
      }
      if (spec.chunks.length > MAX_CHUNKS_PER_STRUCTURE) {
        return {
          changed: false,
          reason: `chunks length ${spec.chunks.length} exceeds max ${MAX_CHUNKS_PER_STRUCTURE}`,
        };
      }
      const validatedChunks: Chunk[] = [];
      for (let i = 0; i < spec.chunks.length; i += 1) {
        const result = validateChunkInput(spec.chunks[i]);
        if (!result.ok) return { changed: false, reason: `chunks[${i}]: ${result.reason}` };
        validatedChunks.push(result.chunk);
      }
      let assignedId = 0;
      const changed = aiEdit((current) => {
        const id = getNextWorldEntityId(current);
        assignedId = id;
        const next: StructureDestructible = {
          id,
          kind: 'structure',
          position: [...spec.position] as Vec3,
          rotation: spec.rotation ? ([...spec.rotation] as Quaternion) : identityQuaternion(),
          ...(typeof spec.density === 'number' ? { density: spec.density } : {}),
          ...(typeof spec.solverMaterialScale === 'number'
            ? { solverMaterialScale: spec.solverMaterialScale }
            : {}),
          ...(spec.fractured === true ? { fractured: true } : {}),
          chunks: validatedChunks,
        };
        return { ...current, destructibles: [...current.destructibles, next] };
      });
      return changed ? { changed, id: assignedId } : { changed };
    },

    removeDestructible(id) {
      const world = accessors.getWorld();
      if (!world.destructibles.some((d) => d.id === id)) {
        return { changed: false, reason: `no destructible with id ${id}` };
      }
      const changed = aiEdit((current) => ({
        ...current,
        destructibles: current.destructibles.filter((d) => d.id !== id),
      }));
      return { changed };
    },

    updateDestructible(id, patch) {
      if (!patch || typeof patch !== 'object') {
        return { changed: false, reason: 'patch must be an object' };
      }
      if (patch.position) {
        const err = validateVec3('position', patch.position);
        if (err) return { changed: false, reason: err };
      }
      const found = accessors.getWorld().destructibles.find((d) => d.id === id);
      if (!found) return { changed: false, reason: `no destructible with id ${id}` };
      const isFactory = found.kind === 'wall' || found.kind === 'tower';
      if (
        isFactory
        && (typeof patch.density === 'number'
          || typeof patch.solverMaterialScale === 'number'
          || typeof patch.fractured === 'boolean')
      ) {
        return {
          changed: false,
          reason: 'density / solverMaterialScale / fractured only apply to structure destructibles',
        };
      }
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === id);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        const nextList = [...current.destructibles];
        if (target.kind === 'structure') {
          const merged: StructureDestructible = {
            ...target,
            ...(patch.position ? { position: [...patch.position] as Vec3 } : {}),
            ...(patch.rotation ? { rotation: [...patch.rotation] as Quaternion } : {}),
            ...(typeof patch.density === 'number' ? { density: patch.density } : {}),
            ...(typeof patch.solverMaterialScale === 'number'
              ? { solverMaterialScale: patch.solverMaterialScale }
              : {}),
          };
          if (typeof patch.fractured === 'boolean') {
            if (patch.fractured) {
              merged.fractured = true;
            } else {
              delete merged.fractured;
            }
          }
          nextList[idx] = merged;
        } else {
          nextList[idx] = {
            ...target,
            ...(patch.position ? { position: [...patch.position] as Vec3 } : {}),
            ...(patch.rotation ? { rotation: [...patch.rotation] as Quaternion } : {}),
          };
        }
        return { ...current, destructibles: nextList };
      });
      return { changed };
    },

    addChunk(structureId, chunk) {
      const found = accessors.getWorld().destructibles.find((d) => d.id === structureId);
      if (!found) return { changed: false, reason: `no destructible with id ${structureId}` };
      if (found.kind !== 'structure') {
        return {
          changed: false,
          reason: 'factory destructibles are immutable; convert to structure first',
        };
      }
      if (found.chunks.length >= MAX_CHUNKS_PER_STRUCTURE) {
        return {
          changed: false,
          reason: `structure ${structureId} is at max chunks (${MAX_CHUNKS_PER_STRUCTURE})`,
        };
      }
      const result = validateChunkInput(chunk);
      if (!result.ok) return { changed: false, reason: result.reason };
      let assignedIndex = -1;
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === structureId);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        if (target.kind !== 'structure') return current;
        assignedIndex = target.chunks.length;
        const updated: StructureDestructible = {
          ...target,
          chunks: [...target.chunks, result.chunk],
        };
        const nextList = [...current.destructibles];
        nextList[idx] = updated;
        return { ...current, destructibles: nextList };
      });
      return changed ? { changed, chunkIndex: assignedIndex } : { changed };
    },

    updateChunk(structureId, chunkIndex, patch) {
      if (!patch || typeof patch !== 'object') {
        return { changed: false, reason: 'patch must be an object' };
      }
      const found = accessors.getWorld().destructibles.find((d) => d.id === structureId);
      if (!found) return { changed: false, reason: `no destructible with id ${structureId}` };
      if (found.kind !== 'structure') {
        return {
          changed: false,
          reason: 'factory destructibles are immutable; convert to structure first',
        };
      }
      if (chunkIndex < 0 || chunkIndex >= found.chunks.length) {
        return {
          changed: false,
          reason: `chunk index ${chunkIndex} out of range [0, ${found.chunks.length})`,
        };
      }
      const merged: Chunk = { ...found.chunks[chunkIndex], ...patch };
      const result = validateChunkInput(merged);
      if (!result.ok) return { changed: false, reason: result.reason };
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === structureId);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        if (target.kind !== 'structure') return current;
        if (chunkIndex >= target.chunks.length) return current;
        const nextChunks = [...target.chunks];
        nextChunks[chunkIndex] = result.chunk;
        const updated: StructureDestructible = { ...target, chunks: nextChunks };
        const nextList = [...current.destructibles];
        nextList[idx] = updated;
        return { ...current, destructibles: nextList };
      });
      return { changed };
    },

    removeChunk(structureId, chunkIndex) {
      const found = accessors.getWorld().destructibles.find((d) => d.id === structureId);
      if (!found) return { changed: false, reason: `no destructible with id ${structureId}` };
      if (found.kind !== 'structure') {
        return {
          changed: false,
          reason: 'factory destructibles are immutable; convert to structure first',
        };
      }
      if (chunkIndex < 0 || chunkIndex >= found.chunks.length) {
        return {
          changed: false,
          reason: `chunk index ${chunkIndex} out of range [0, ${found.chunks.length})`,
        };
      }
      if (found.chunks.length === 1) {
        return {
          changed: false,
          reason: 'cannot remove last chunk; use removeDestructible to remove the whole structure',
        };
      }
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === structureId);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        if (target.kind !== 'structure') return current;
        const nextChunks = target.chunks.filter((_, i) => i !== chunkIndex);
        const updated: StructureDestructible = { ...target, chunks: nextChunks };
        const nextList = [...current.destructibles];
        nextList[idx] = updated;
        return { ...current, destructibles: nextList };
      });
      return { changed };
    },

    duplicateChunk(structureId, chunkIndex, offset) {
      const found = accessors.getWorld().destructibles.find((d) => d.id === structureId);
      if (!found) return { changed: false, reason: `no destructible with id ${structureId}` };
      if (found.kind !== 'structure') {
        return {
          changed: false,
          reason: 'factory destructibles are immutable; convert to structure first',
        };
      }
      if (chunkIndex < 0 || chunkIndex >= found.chunks.length) {
        return {
          changed: false,
          reason: `chunk index ${chunkIndex} out of range [0, ${found.chunks.length})`,
        };
      }
      if (found.chunks.length >= MAX_CHUNKS_PER_STRUCTURE) {
        return {
          changed: false,
          reason: `structure ${structureId} is at max chunks (${MAX_CHUNKS_PER_STRUCTURE})`,
        };
      }
      if (offset !== undefined) {
        const err = validateVec3('offset', offset);
        if (err) return { changed: false, reason: err };
      }
      const offsetVec: Vec3 = offset ? ([...offset] as Vec3) : [0, 0, 0];
      let assignedIndex = -1;
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === structureId);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        if (target.kind !== 'structure') return current;
        const source = target.chunks[chunkIndex];
        const cloned: Chunk = {
          ...source,
          position: [
            source.position[0] + offsetVec[0],
            source.position[1] + offsetVec[1],
            source.position[2] + offsetVec[2],
          ],
          rotation: [...source.rotation] as Quaternion,
          ...(source.halfExtents ? { halfExtents: [...source.halfExtents] as Vec3 } : {}),
        };
        assignedIndex = target.chunks.length;
        const updated: StructureDestructible = {
          ...target,
          chunks: [...target.chunks, cloned],
        };
        const nextList = [...current.destructibles];
        nextList[idx] = updated;
        return { ...current, destructibles: nextList };
      });
      return changed ? { changed, chunkIndex: assignedIndex } : { changed };
    },

    convertFactoryToStructure(id) {
      const found = accessors.getWorld().destructibles.find((d) => d.id === id);
      if (!found) return { changed: false, reason: `no destructible with id ${id}` };
      if (found.kind === 'structure') {
        return { changed: false, reason: `destructible ${id} is already a structure` };
      }
      const chunks = expandFactoryKindToChunks(found.kind);
      const changed = aiEdit((current) => {
        const idx = current.destructibles.findIndex((d) => d.id === id);
        if (idx === -1) return current;
        const target = current.destructibles[idx];
        if (target.kind === 'structure') return current;
        const structure: StructureDestructible = {
          id: target.id,
          kind: 'structure',
          position: [...target.position] as Vec3,
          rotation: [...target.rotation] as Quaternion,
          chunks,
        };
        const nextList = [...current.destructibles];
        nextList[idx] = structure;
        return { ...current, destructibles: nextList };
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

    deformTerrainAlongSpline(spec) {
      const spline = accessors.getSplines().get(spec.splineId);
      if (!spline) return { changed: false };
      if (!Array.isArray(spec.profile) || spec.profile.length < 2) return { changed: false };
      const before = accessors.getWorld();
      const changed = aiEdit((current) =>
        applyTerrainSplineDeform(current, {
          spline,
          profile: spec.profile,
          mode: spec.mode ?? 'absolute',
          applyMode: spec.applyMode ?? 'blend',
          strength: spec.strength ?? 1,
          falloff: spec.falloff ?? 2,
          sampleSpacing: spec.sampleSpacing ?? 1,
        }),
      );
      if (!changed) return { changed: false };
      return { changed: true, ...computeTerrainMutationStats(before, accessors.getWorld()) };
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

    // ---- SPLINE CRUD ----
    createSpline(spec) {
      const id = generateCommitId();
      const spline: SplineData = {
        id,
        name: spec.name,
        points: spec.points.map((p) => ({ x: p.x, z: p.z })),
        closed: spec.closed ?? false,
        interpolation: spec.interpolation ?? 'polyline',
        tension: spec.tension ?? 0.5,
      };
      accessors.setSpline(id, spline);
      return { id };
    },
    getSpline(id) {
      const spline = accessors.getSplines().get(id);
      return spline ? cloneJson(spline) : null;
    },
    updateSpline(id, patch) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return { changed: false };
      const updated: SplineData = {
        ...spline,
        ...(patch.points ? { points: patch.points.map((p) => ({ x: p.x, z: p.z })) } : {}),
        ...(typeof patch.closed === 'boolean' ? { closed: patch.closed } : {}),
        ...(patch.interpolation ? { interpolation: patch.interpolation } : {}),
        ...(typeof patch.tension === 'number' ? { tension: patch.tension } : {}),
        ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
      };
      accessors.setSpline(id, updated);
      return { changed: true };
    },
    deleteSpline(id) {
      return { changed: accessors.deleteSpline(id) };
    },
    listSplines() {
      return Array.from(accessors.getSplines().values()).map((s) => cloneJson(s));
    },

    // ---- SPLINE MATH ----
    splineLength(id) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      return computeSplineLength(spline);
    },
    sampleSpline(id, opts) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      const table = buildArcLengthTable(spline);
      const totalLen = table[table.length - 1]?.distance ?? 0;
      if (totalLen <= 0) return [];

      let distances: number[];
      if (opts.distances) {
        distances = opts.distances;
      } else if (opts.spacing && opts.spacing > 0) {
        distances = [];
        for (let d = 0; d <= totalLen; d += opts.spacing) distances.push(d);
      } else {
        const count = opts.count ?? 20;
        distances = [];
        for (let i = 0; i < count; i++) distances.push((i / Math.max(1, count - 1)) * totalLen);
      }
      return distances.map((d) => sampleSplineAtDistance(spline, d, table));
    },
    splineTangent(id, distance) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      const table = buildArcLengthTable(spline);
      return splineTangentAtDistance(spline, distance, table);
    },
    splineNormal(id, distance) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      const table = buildArcLengthTable(spline);
      return splineNormalAtDistance(spline, distance, table);
    },
    splineBounds(id) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      return computeSplineBounds(spline);
    },
    resampleSpline(id, spacing) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      return resampleSplineBySpacing(spline, spacing);
    },
    offsetSpline(id, offset, spacing) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      return offsetSplineCurve(spline, offset, spacing);
    },
    findSplineSelfIntersections(id) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      return findSelfIntersections(spline);
    },
    projectOntoSpline(id, point) {
      const spline = accessors.getSplines().get(id);
      if (!spline) return null;
      const table = buildArcLengthTable(spline);
      return projectPointOntoSpline(spline, point, table);
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

type ValidatedChunk = { ok: true; chunk: Chunk } | { ok: false; reason: string };

function validateChunkInput(raw: unknown): ValidatedChunk {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'chunk must be an object' };
  }
  const c = raw as Partial<Chunk> & { shape?: string };
  if (c.shape !== 'box' && c.shape !== 'sphere' && c.shape !== 'capsule') {
    return { ok: false, reason: `unknown shape ${String(c.shape)}; must be box | sphere | capsule` };
  }
  const position = c.position ?? [0, 0, 0];
  const posErr = validateVec3('position', position);
  if (posErr) return { ok: false, reason: posErr };
  if (c.rotation !== undefined) {
    if (
      !Array.isArray(c.rotation)
      || c.rotation.length !== 4
      || c.rotation.some((v) => typeof v !== 'number' || !Number.isFinite(v))
    ) {
      return { ok: false, reason: 'rotation must be a [x, y, z, w] tuple of finite numbers' };
    }
  }
  if (c.shape === 'box') {
    if (
      !Array.isArray(c.halfExtents)
      || c.halfExtents.length !== 3
      || c.halfExtents.some((v) => typeof v !== 'number' || !(v > 0))
    ) {
      return { ok: false, reason: 'box chunk requires halfExtents: [x, y, z] with positive numbers' };
    }
  } else if (c.shape === 'sphere') {
    if (typeof c.radius !== 'number' || !(c.radius > 0)) {
      return { ok: false, reason: 'sphere chunk requires positive radius' };
    }
  } else {
    if (typeof c.radius !== 'number' || !(c.radius > 0)) {
      return { ok: false, reason: 'capsule chunk requires positive radius' };
    }
    if (typeof c.height !== 'number' || !(c.height >= 0)) {
      return { ok: false, reason: 'capsule chunk requires non-negative height' };
    }
  }
  if (c.mass !== undefined && (typeof c.mass !== 'number' || !(c.mass >= 0))) {
    return { ok: false, reason: 'mass must be a non-negative number when provided' };
  }
  const chunk: Chunk = {
    shape: c.shape,
    position: [...(position as Vec3)] as Vec3,
    rotation: c.rotation ? ([...c.rotation] as Quaternion) : identityQuaternion(),
  };
  if (c.shape === 'box' && Array.isArray(c.halfExtents)) {
    chunk.halfExtents = [...c.halfExtents] as Vec3;
  }
  if ((c.shape === 'sphere' || c.shape === 'capsule') && typeof c.radius === 'number') {
    chunk.radius = c.radius;
  }
  if (c.shape === 'capsule' && typeof c.height === 'number') {
    chunk.height = c.height;
  }
  if (typeof c.mass === 'number') chunk.mass = c.mass;
  if (typeof c.material === 'string') chunk.material = c.material;
  if (c.anchor === true) chunk.anchor = true;
  return { ok: true, chunk };
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
