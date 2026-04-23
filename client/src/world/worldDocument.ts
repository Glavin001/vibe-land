import defaultWorldDocumentJson from '../../../worlds/trail.world.json';
import { getSharedVehicleDefinition } from '../wasm/sharedVehicleDefinitions';

export const WORLD_DOCUMENT_VERSION = 2;
export const DEFAULT_WORLD_HISTORY_LIMIT = 3;
export const TERRAIN_MIN_HEIGHT = -10;
export const TERRAIN_MAX_HEIGHT = 50;
const TERRAIN_EXPANSION_TAPER_FRACTION = 0.18;

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export type TerrainExpandDirection = 'north' | 'south' | 'east' | 'west';

export type WorldTerrainTile = {
  tileX: number;
  tileZ: number;
  heights: number[];
  materials?: TerrainMaterial[];
  materialWeights?: number[];
};

export type TerrainTileCoordinate = {
  tileX: number;
  tileZ: number;
};

export type TerrainRampStencil = {
  centerX: number;
  centerZ: number;
  width: number;
  length: number;
  gradePct: number;
  yawRad: number;
  mode: 'raise' | 'lower';
  strength: number;
  targetHeight: number;
  targetEdge: 'start' | 'end';
  targetKind: 'min' | 'max';
  sideFalloffM: number;
  startFalloffM: number;
  endFalloffM: number;
};

export type TerrainMaterial = {
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  friction: number;
  restitution: number;
  flammability: number;
  fuelLoad: number;
  burnRate: number;
  moisture: number;
};

export const DEFAULT_TERRAIN_MATERIALS: TerrainMaterial[] = [
  // Natural / auto-generated (first 4 drive splatmap auto-gen)
  { name: 'grass', color: '#5a8c46', roughness: 0.95, metalness: 0.02, friction: 0.6, restitution: 0.1, flammability: 0.5, fuelLoad: 0.15, burnRate: 0.85, moisture: 0.4 },
  { name: 'rock', color: '#8a8278', roughness: 0.92, metalness: 0.05, friction: 0.8, restitution: 0.3, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.1 },
  { name: 'dirt', color: '#87684a', roughness: 0.98, metalness: 0.01, friction: 0.5, restitution: 0.05, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.3 },
  { name: 'sand', color: '#d6c08d', roughness: 0.96, metalness: 0.01, friction: 0.4, restitution: 0.05, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.05 },
  // Paintable extras (not auto-generated; apply via paint tool)
  { name: 'ice', color: '#c8e6f0', roughness: 0.15, metalness: 0.0, friction: 0.05, restitution: 0.05, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 1.0 },
  { name: 'snow', color: '#f4f8fa', roughness: 0.85, metalness: 0.0, friction: 0.3, restitution: 0.02, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.9 },
  { name: 'mud', color: '#4a3a28', roughness: 0.98, metalness: 0.02, friction: 0.35, restitution: 0.0, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.95 },
  { name: 'pavement', color: '#3a3b40', roughness: 0.75, metalness: 0.05, friction: 0.9, restitution: 0.15, flammability: 0.0, fuelLoad: 0.0, burnRate: 0.0, moisture: 0.05 },
  { name: 'wood', color: '#6b4a2a', roughness: 0.85, metalness: 0.02, friction: 0.65, restitution: 0.2, flammability: 0.4, fuelLoad: 0.9, burnRate: 0.15, moisture: 0.15 },
  { name: 'lava', color: '#ff5a1a', roughness: 0.5, metalness: 0.0, friction: 0.4, restitution: 0.1, flammability: 1.0, fuelLoad: 1.0, burnRate: 0.05, moisture: 0.0 },
];

export const MAX_MATERIAL_CHANNELS = 4;

export type WorldDocument = {
  version: number;
  meta: {
    name: string;
    description: string;
  };
  terrain: {
    tileGridSize: number;
    tileHalfExtentM: number;
    tiles: WorldTerrainTile[];
  };
  staticProps: StaticProp[];
  dynamicEntities: DynamicEntity[];
  /**
   * Blast-stress-solver backed destructible structures. Optional — older
   * world documents without the field default to `[]` so existing saves
   * keep loading.
   */
  destructibles: Destructible[];
};

type LegacyTerrain = {
  gridSize: number;
  halfExtentM: number;
  heights: number[];
};

export type StaticProp = {
  id: number;
  kind: 'cuboid';
  position: Vec3;
  rotation: Quaternion;
  halfExtents: Vec3;
  material?: string;
};

export type DynamicEntity = {
  id: number;
  kind: 'box' | 'ball' | 'vehicle' | 'battery';
  position: Vec3;
  rotation: Quaternion;
  halfExtents?: Vec3;
  radius?: number;
  vehicleType?: number;
  energy?: number;
  height?: number;
};

/**
 * A destructible structure backed by NVIDIA Blast's stress solver in
 * single-player (WASM) builds; native-server multiplayer falls back to
 * independent dynamic rigid bodies (one per chunk).
 *
 * `wall` and `tower` are factory kinds — opaque scenarios produced by
 * preset Blast builders. `structure` is fully authored: chunks are
 * composed from `box | sphere | capsule` primitives and auto-bonded by
 * Blast at build time (chunks must be in contact for bonds to form).
 *
 * Chunk ordering matters: the native-server fallback assigns each chunk a
 * stable rigid-body id of `(destructible.id << 12) | chunk_index`, so a
 * single destructible can hold at most **4096 chunks**.
 */
export type Destructible =
  | FactoryDestructible
  | StructureDestructible;

export type FactoryDestructible = {
  id: number;
  kind: 'wall' | 'tower';
  position: Vec3;
  rotation: Quaternion;
};

export type StructureDestructible = {
  id: number;
  kind: 'structure';
  position: Vec3;
  rotation: Quaternion;
  /** Material density in kg/m³; defaults to 2400 when omitted. */
  density?: number;
  /** Multiplier on Blast per-material stiffness; defaults to 1. */
  solverMaterialScale?: number;
  /**
   * When true, each authored chunk is subdivided into brick-sized
   * sub-chunks at spawn time and the Blast auto-bonder wires them into
   * a single bonded network. Disabled by default. Applies on both
   * single-player (Blast) and native (per-chunk rigid body) paths.
   */
  fractured?: boolean;
  chunks: Chunk[];
};

export type ChunkShape = 'box' | 'sphere' | 'capsule';

/**
 * One authored chunk inside a `structure` destructible. Position and
 * rotation are in the structure's local frame (applied after the
 * structure's world pose).
 *
 * Shape-specific size fields:
 *  - `box` → `halfExtents` required.
 *  - `sphere` → `radius` required.
 *  - `capsule` → `radius` + `height` required (cylinder segment length,
 *    excluding the two hemispherical caps).
 *
 * `mass` overrides the density-derived mass. `anchor=true` marks the
 * chunk as a static support (replaces the implicit `y==0` rule). On
 * native servers, anchored chunks are spawned as static cuboids
 * (sphere/capsule anchors fall back to a tight-fit cuboid AABB).
 */
export type Chunk = {
  shape: ChunkShape;
  position: Vec3;
  rotation: Quaternion;
  halfExtents?: Vec3;
  radius?: number;
  height?: number;
  mass?: number;
  material?: string;
  anchor?: boolean;
};

export const DEFAULT_STRUCTURE_DENSITY_KG_M3 = 2400;
export const DEFAULT_STRUCTURE_SOLVER_MATERIAL_SCALE = 1;
export const MAX_CHUNKS_PER_STRUCTURE = 4096;
/**
 * Target brick edge length (meters) used when `StructureDestructible.fractured`
 * is true. Authored chunks are subdivided so no resulting sub-brick is smaller
 * than this on any axis. Picked around the size of a concrete masonry unit.
 */
export const FRACTURE_BRICK_EDGE_M = 0.25;

export type WorldDraftRevision = {
  id: string;
  savedAt: string;
  summary: string;
  world: WorldDocument;
};

export const DEFAULT_WORLD_DOCUMENT: WorldDocument = parseWorldDocument(defaultWorldDocumentJson);

export function createDefaultWorldDocument(): WorldDocument {
  return cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
}

export function createEmptyWorldDocument(): WorldDocument {
  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: {
      name: 'Untitled World',
      description: '',
    },
    terrain: {
      tileGridSize: DEFAULT_WORLD_DOCUMENT.terrain.tileGridSize,
      tileHalfExtentM: DEFAULT_WORLD_DOCUMENT.terrain.tileHalfExtentM,
      tiles: [createEmptyTerrainTile(DEFAULT_WORLD_DOCUMENT.terrain.tileGridSize, 0, 0)],
    },
    staticProps: [],
    dynamicEntities: [],
    destructibles: [],
  };
}

export function parseWorldDocument(raw: unknown): WorldDocument {
  if (!raw || typeof raw !== 'object') {
    throw new Error('World document must be an object.');
  }
  const candidate = raw as {
    version?: number;
    meta?: {
      name?: string;
      description?: string;
    };
    terrain?: Partial<WorldDocument['terrain']> & Partial<LegacyTerrain>;
    staticProps?: unknown[];
    dynamicEntities?: unknown[];
    destructibles?: unknown[];
  };
  if (!candidate.terrain) {
    throw new Error('World document terrain is missing.');
  }
  if (!Array.isArray(candidate.staticProps) || !Array.isArray(candidate.dynamicEntities)) {
    throw new Error('World document entity arrays are missing.');
  }
  const rawDestructibles = Array.isArray(candidate.destructibles) ? candidate.destructibles : [];

  const terrain = normalizeTerrain(candidate.terrain);
  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: {
      name: candidate.meta?.name ?? 'Untitled World',
      description: candidate.meta?.description ?? '',
    },
    terrain,
    staticProps: candidate.staticProps.map((entity) => ({
      ...(entity as StaticProp),
      rotation: normalizeQuaternion((entity as Partial<StaticProp>).rotation),
    })),
    dynamicEntities: candidate.dynamicEntities.map((entity) => ({
      ...(entity as DynamicEntity),
      rotation: normalizeQuaternion((entity as Partial<DynamicEntity>).rotation),
    })),
    destructibles: rawDestructibles.map((raw) => normalizeDestructible(raw)),
  };
}

function normalizeDestructible(raw: unknown): Destructible {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Destructible entry must be an object.');
  }
  const candidate = raw as {
    id?: number;
    kind?: string;
    position?: Vec3;
    rotation?: unknown;
    density?: number;
    solverMaterialScale?: number;
    fractured?: boolean;
    chunks?: unknown[];
  };
  if (typeof candidate.id !== 'number') {
    throw new Error('Destructible is missing id.');
  }
  const position = (candidate.position ?? [0, 0, 0]) as Vec3;
  const rotation = normalizeQuaternion(candidate.rotation as Partial<Quaternion> | undefined);
  if (candidate.kind === 'wall' || candidate.kind === 'tower') {
    return { id: candidate.id, kind: candidate.kind, position, rotation };
  }
  if (candidate.kind === 'structure') {
    const rawChunks = Array.isArray(candidate.chunks) ? candidate.chunks : [];
    if (rawChunks.length > MAX_CHUNKS_PER_STRUCTURE) {
      throw new Error(
        `Destructible ${candidate.id} has ${rawChunks.length} chunks (max ${MAX_CHUNKS_PER_STRUCTURE}).`,
      );
    }
    const chunks = rawChunks.map((rawChunk, index) => normalizeChunk(rawChunk, candidate.id!, index));
    return {
      id: candidate.id,
      kind: 'structure',
      position,
      rotation,
      ...(typeof candidate.density === 'number' ? { density: candidate.density } : {}),
      ...(typeof candidate.solverMaterialScale === 'number'
        ? { solverMaterialScale: candidate.solverMaterialScale }
        : {}),
      ...(candidate.fractured === true ? { fractured: true } : {}),
      chunks,
    };
  }
  throw new Error(`Destructible ${candidate.id} has unknown kind ${String(candidate.kind)}.`);
}

function normalizeChunk(raw: unknown, structureId: number, chunkIndex: number): Chunk {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Chunk [${structureId}:${chunkIndex}] must be an object.`);
  }
  const c = raw as Partial<Chunk> & { shape?: string };
  if (c.shape !== 'box' && c.shape !== 'sphere' && c.shape !== 'capsule') {
    throw new Error(`Chunk [${structureId}:${chunkIndex}] has unknown shape ${String(c.shape)}.`);
  }
  const position = (c.position ?? [0, 0, 0]) as Vec3;
  const rotation = normalizeQuaternion(c.rotation as Partial<Quaternion> | undefined);
  if (c.shape === 'box') {
    if (!Array.isArray(c.halfExtents) || c.halfExtents.length !== 3) {
      throw new Error(`Box chunk [${structureId}:${chunkIndex}] is missing halfExtents.`);
    }
  } else if (c.shape === 'sphere') {
    if (typeof c.radius !== 'number' || !(c.radius > 0)) {
      throw new Error(`Sphere chunk [${structureId}:${chunkIndex}] is missing positive radius.`);
    }
  } else if (c.shape === 'capsule') {
    if (typeof c.radius !== 'number' || !(c.radius > 0)) {
      throw new Error(`Capsule chunk [${structureId}:${chunkIndex}] is missing positive radius.`);
    }
    if (typeof c.height !== 'number' || !(c.height >= 0)) {
      throw new Error(`Capsule chunk [${structureId}:${chunkIndex}] is missing non-negative height.`);
    }
  }
  const chunk: Chunk = {
    shape: c.shape,
    position,
    rotation,
  };
  if (Array.isArray(c.halfExtents) && c.halfExtents.length === 3) {
    chunk.halfExtents = [...c.halfExtents] as Vec3;
  }
  if (typeof c.radius === 'number') chunk.radius = c.radius;
  if (typeof c.height === 'number') chunk.height = c.height;
  if (typeof c.mass === 'number') chunk.mass = c.mass;
  if (typeof c.material === 'string') chunk.material = c.material;
  if (c.anchor === true) chunk.anchor = true;
  return chunk;
}

export function serializeWorldDocument(world: WorldDocument): string {
  return JSON.stringify(
    {
      ...world,
      version: WORLD_DOCUMENT_VERSION,
      terrain: {
        tileGridSize: world.terrain.tileGridSize,
        tileHalfExtentM: world.terrain.tileHalfExtentM,
        tiles: sortTerrainTiles(world.terrain.tiles).map((tile) => {
          const entry: Record<string, unknown> = {
            tileX: tile.tileX,
            tileZ: tile.tileZ,
            heights: [...tile.heights],
          };
          if (tile.materials && tile.materials.length > 0) {
            entry.materials = tile.materials;
          }
          if (tile.materialWeights && tile.materialWeights.length > 0) {
            entry.materialWeights = [...tile.materialWeights];
          }
          return entry;
        }),
      },
    },
    null,
    2,
  );
}

export function cloneWorldDocument(world: WorldDocument): WorldDocument {
  if (typeof structuredClone === 'function') {
    return structuredClone(world);
  }
  return JSON.parse(JSON.stringify(world)) as WorldDocument;
}

export function removeVehicleEntitiesFromWorldDocument(world: WorldDocument): WorldDocument {
  if (!world.dynamicEntities.some((entity) => entity.kind === 'vehicle')) {
    return world;
  }
  return {
    ...world,
    dynamicEntities: world.dynamicEntities.filter((entity) => entity.kind !== 'vehicle'),
  };
}

export function buildDraftRevision(world: WorldDocument, summary: string, now = new Date()): WorldDraftRevision {
  return {
    id: `${now.getTime()}`,
    savedAt: now.toISOString(),
    summary,
    world: cloneWorldDocument(world),
  };
}

export function getNextWorldEntityId(world: WorldDocument): number {
  const highestStatic = world.staticProps.reduce((max, entity) => Math.max(max, entity.id), 0);
  const highestDynamic = world.dynamicEntities.reduce((max, entity) => Math.max(max, entity.id), 0);
  const highestDestructible = (world.destructibles ?? []).reduce((max, entity) => Math.max(max, entity.id), 0);
  return Math.max(highestStatic, highestDynamic, highestDestructible) + 1;
}

export function quaternionFromYaw(yawRad: number): Quaternion {
  const halfYaw = yawRad * 0.5;
  return [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)];
}

export function yawFromQuaternion(rotation: Quaternion): number {
  const [x, y, z, w] = rotation;
  const sinyCosp = 2 * (w * y + x * z);
  const cosyCosp = 1 - 2 * (y * y + z * z);
  return Math.atan2(sinyCosp, cosyCosp);
}

export function identityQuaternion(): Quaternion {
  return [0, 0, 0, 1];
}

export function terrainTileSideLength(world: WorldDocument): number {
  return world.terrain.tileHalfExtentM * 2;
}

export function terrainTileSampleCount(world: WorldDocument): number {
  return world.terrain.tileGridSize * world.terrain.tileGridSize;
}

export function sortTerrainTiles(tiles: WorldTerrainTile[]): WorldTerrainTile[] {
  return [...tiles].sort((a, b) => (a.tileZ - b.tileZ) || (a.tileX - b.tileX));
}

export function getTerrainTileKey(tileX: number, tileZ: number): string {
  return `${tileX}:${tileZ}`;
}

export function getTerrainTileCenter(world: WorldDocument, tileX: number, tileZ: number): [number, number] {
  const side = terrainTileSideLength(world);
  return [tileX * side, tileZ * side];
}

export function getTerrainTile(world: WorldDocument, tileX: number, tileZ: number): WorldTerrainTile | null {
  return world.terrain.tiles.find((tile) => tile.tileX === tileX && tile.tileZ === tileZ) ?? null;
}

export function getTerrainTileHeight(world: WorldDocument, tile: Pick<WorldTerrainTile, 'heights'>, row: number, col: number): number {
  return tile.heights[row * world.terrain.tileGridSize + col] ?? 0;
}

export function getTerrainTileWorldPosition(
  world: WorldDocument,
  tile: Pick<WorldTerrainTile, 'tileX' | 'tileZ'>,
  row: number,
  col: number,
): [number, number] {
  const last = world.terrain.tileGridSize - 1;
  if (last <= 0) {
    return getTerrainTileCenter(world, tile.tileX, tile.tileZ);
  }
  const side = terrainTileSideLength(world);
  const [centerX, centerZ] = getTerrainTileCenter(world, tile.tileX, tile.tileZ);
  const x = centerX - world.terrain.tileHalfExtentM + side * (col / last);
  const z = centerZ - world.terrain.tileHalfExtentM + side * (row / last);
  return [x, z];
}

export function getTerrainWorldPosition(
  world: WorldDocument,
  row: number,
  col: number,
  tileX = 0,
  tileZ = 0,
): [number, number] {
  return getTerrainTileWorldPosition(world, { tileX, tileZ }, row, col);
}

export function getTerrainTileBounds(world: WorldDocument, tileX: number, tileZ: number): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const [centerX, centerZ] = getTerrainTileCenter(world, tileX, tileZ);
  return {
    minX: centerX - world.terrain.tileHalfExtentM,
    maxX: centerX + world.terrain.tileHalfExtentM,
    minZ: centerZ - world.terrain.tileHalfExtentM,
    maxZ: centerZ + world.terrain.tileHalfExtentM,
  };
}

export function getTerrainWorldBounds(world: WorldDocument): {
  minTileX: number;
  maxTileX: number;
  minTileZ: number;
  maxTileZ: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  if (world.terrain.tiles.length === 0) {
    return {
      minTileX: 0,
      maxTileX: 0,
      minTileZ: 0,
      maxTileZ: 0,
      minX: -world.terrain.tileHalfExtentM,
      maxX: world.terrain.tileHalfExtentM,
      minZ: -world.terrain.tileHalfExtentM,
      maxZ: world.terrain.tileHalfExtentM,
    };
  }

  const tileXs = world.terrain.tiles.map((tile) => tile.tileX);
  const tileZs = world.terrain.tiles.map((tile) => tile.tileZ);
  const minTileX = Math.min(...tileXs);
  const maxTileX = Math.max(...tileXs);
  const minTileZ = Math.min(...tileZs);
  const maxTileZ = Math.max(...tileZs);
  const minBounds = getTerrainTileBounds(world, minTileX, minTileZ);
  const maxBounds = getTerrainTileBounds(world, maxTileX, maxTileZ);
  return {
    minTileX,
    maxTileX,
    minTileZ,
    maxTileZ,
    minX: minBounds.minX,
    maxX: maxBounds.maxX,
    minZ: minBounds.minZ,
    maxZ: maxBounds.maxZ,
  };
}

export function sampleTerrainHeightAtWorldPosition(world: WorldDocument, x: number, z: number): number {
  if (world.terrain.tiles.length === 0) {
    return 0;
  }

  const bounds = getTerrainWorldBounds(world);
  const isInsideBounds = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
  const sampleX = isInsideBounds ? x : clamp(x, bounds.minX, bounds.maxX);
  const sampleZ = isInsideBounds ? z : clamp(z, bounds.minZ, bounds.maxZ);
  const tile = getTerrainTileForWorldPosition(world, sampleX, sampleZ, { allowNearest: !isInsideBounds });
  if (!tile) {
    return 0;
  }

  const [centerX, centerZ] = getTerrainTileCenter(world, tile.tileX, tile.tileZ);
  const side = terrainTileSideLength(world);
  const maxIndex = world.terrain.tileGridSize - 1;
  const maxCell = world.terrain.tileGridSize - 2;
  const col = clamp(((sampleX - centerX + world.terrain.tileHalfExtentM) / side) * maxIndex, 0, maxIndex);
  const row = clamp(((sampleZ - centerZ + world.terrain.tileHalfExtentM) / side) * maxIndex, 0, maxIndex);
  const cellCol = clamp(Math.floor(col), 0, maxCell);
  const cellRow = clamp(Math.floor(row), 0, maxCell);
  const u = col - cellCol;
  const v = row - cellRow;
  const h00 = getTerrainTileHeight(world, tile, cellRow, cellCol);
  const h10 = getTerrainTileHeight(world, tile, cellRow, cellCol + 1);
  const h01 = getTerrainTileHeight(world, tile, cellRow + 1, cellCol);
  const h11 = getTerrainTileHeight(world, tile, cellRow + 1, cellCol + 1);
  if (u + v <= 1) {
    return h00 + (h10 - h00) * u + (h01 - h00) * v;
  }
  return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

export function getMinimumDynamicEntityY(
  world: WorldDocument,
  entity: Pick<DynamicEntity, 'kind' | 'position' | 'halfExtents' | 'radius' | 'vehicleType'>,
): number {
  const terrainY = sampleTerrainHeightAtWorldPosition(world, entity.position[0], entity.position[2]);
  if (entity.kind === 'box') {
    return terrainY + (entity.halfExtents?.[1] ?? 0.5) + 0.05;
  }
  if (entity.kind === 'ball') {
    return terrainY + (entity.radius ?? 0.5) + 0.05;
  }
  if (entity.kind === 'vehicle') {
    const definition = getSharedVehicleDefinition(entity.vehicleType);
    const wheelClearance = definition.suspensionRestLengthM
      + definition.suspensionTravelM
      + definition.wheelRadiusM;
    const chassisClearance = definition.chassisHalfExtents.y + 0.1;
    return terrainY + Math.max(wheelClearance, chassisClearance) + 0.1;
  }
  return terrainY + 0.85;
}

export function applyTerrainBrush(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
  strength: number,
  mode: 'raise' | 'lower',
  limits?: {
    minHeight?: number;
    maxHeight?: number;
  },
): WorldDocument {
  const next: WorldDocument = {
    ...world,
    terrain: {
      ...world.terrain,
      tiles: [...world.terrain.tiles],
    },
  };
  const direction = mode === 'raise' ? 1 : -1;
  const lowerLimit = clampNumber(limits?.minHeight ?? TERRAIN_MIN_HEIGHT, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  const upperLimit = clampNumber(limits?.maxHeight ?? TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  const brushMinHeight = Math.min(lowerLimit, upperLimit);
  const brushMaxHeight = Math.max(lowerLimit, upperLimit);
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const distance = Math.hypot(x - centerX, z - centerZ);
        if (distance > radius) {
          continue;
        }
        const falloff = 1 - distance / radius;
        const delta = strength * falloff * falloff * direction;
        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        let nextHeight = currentHeight;
        if (mode === 'raise') {
          if (currentHeight >= brushMaxHeight) {
            continue;
          }
          nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, brushMaxHeight);
        } else {
          if (currentHeight <= brushMinHeight) {
            continue;
          }
          nextHeight = clampNumber(currentHeight + delta, brushMinHeight, TERRAIN_MAX_HEIGHT);
        }
        if (nextHeight === currentHeight) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = {
            ...sourceTile,
            heights: [...sourceTile.heights],
          };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }

  return mutated ? next : world;
}

export function applyTerrainRampStencil(world: WorldDocument, ramp: TerrainRampStencil): WorldDocument {
  const next: WorldDocument = {
    ...world,
    terrain: {
      ...world.terrain,
      tiles: [...world.terrain.tiles],
    },
  };
  const width = Math.max(0.5, ramp.width);
  const length = Math.max(0.5, ramp.length);
  const halfWidth = width * 0.5;
  const halfLength = length * 0.5;
  const forwardX = Math.sin(ramp.yawRad);
  const forwardZ = Math.cos(ramp.yawRad);
  const rightX = forwardZ;
  const rightZ = -forwardX;
  const rampStrength = clampNumber(ramp.strength, 0, 1);
  const sideFalloff = Math.max(0, ramp.sideFalloffM);
  const startFalloff = Math.max(0, ramp.startFalloffM);
  const endFalloff = Math.max(0, ramp.endFalloffM);
  const { startHeight, endHeight } = getTerrainRampEndpointHeights(ramp);
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const dx = x - ramp.centerX;
        const dz = z - ramp.centerZ;
        const localAcross = dx * rightX + dz * rightZ;
        const localAlong = dx * forwardX + dz * forwardZ;

        const sideDistance = Math.max(0, Math.abs(localAcross) - halfWidth);
        const startDistance = Math.max(0, -halfLength - localAlong);
        const endDistance = Math.max(0, localAlong - halfLength);
        const sideInfluence = sideDistance === 0 ? 1 : computeRampFalloff(sideDistance, sideFalloff);
        const alongInfluence = startDistance > 0
          ? computeRampFalloff(startDistance, startFalloff)
          : endDistance > 0
            ? computeRampFalloff(endDistance, endFalloff)
            : 1;
        const influence = sideInfluence * alongInfluence;
        if (influence <= 0) {
          continue;
        }

        const clampedAlong = clampNumber(localAlong, -halfLength, halfLength);
        const along01 = clampNumber((clampedAlong + halfLength) / length, 0, 1);
        const targetHeight = lerp(startHeight, endHeight, along01);
        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        if (ramp.mode === 'raise' && targetHeight <= currentHeight) {
          continue;
        }
        if (ramp.mode === 'lower' && targetHeight >= currentHeight) {
          continue;
        }
        const nextHeight = clampNumber(
          currentHeight + rampStrength * influence * (targetHeight - currentHeight),
          TERRAIN_MIN_HEIGHT,
          TERRAIN_MAX_HEIGHT,
        );
        if (Math.abs(nextHeight - currentHeight) <= 1e-6) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = {
            ...sourceTile,
            heights: [...sourceTile.heights],
          };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }

  return mutated ? next : world;
}

export function flattenTerrainBrush(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
  targetHeight: number,
  strength: number,
): WorldDocument {
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  const clampedTarget = clampNumber(targetHeight, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  const clampedStrength = clampNumber(strength, 0, 1);
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const distance = Math.hypot(x - centerX, z - centerZ);
        if (distance > radius) {
          continue;
        }
        const falloff = 1 - distance / radius;
        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        const delta = clampedStrength * falloff * falloff * (clampedTarget - currentHeight);
        const nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        if (Math.abs(nextHeight - currentHeight) <= 1e-6) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }
  return mutated ? next : world;
}

export function smoothTerrainBrush(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
  strength: number,
): WorldDocument {
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  const clampedStrength = clampNumber(strength, 0, 1);
  const step = terrainTileSideLength(world) / (world.terrain.tileGridSize - 1);
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const distance = Math.hypot(x - centerX, z - centerZ);
        if (distance > radius) {
          continue;
        }
        const falloff = 1 - distance / radius;
        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        // Read 4 cardinal neighbors from the ORIGINAL world to avoid directional bias
        const nH = sampleTerrainHeightAtWorldPosition(world, x, z - step);
        const sH = sampleTerrainHeightAtWorldPosition(world, x, z + step);
        const wH = sampleTerrainHeightAtWorldPosition(world, x - step, z);
        const eH = sampleTerrainHeightAtWorldPosition(world, x + step, z);
        const avg = (nH + sH + wH + eH) * 0.25;
        const delta = clampedStrength * falloff * falloff * (avg - currentHeight);
        const nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        if (Math.abs(nextHeight - currentHeight) <= 1e-6) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }
  return mutated ? next : world;
}

export function applyTerrainNoiseBrush(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
  amplitude: number,
  scale: number,
  octaves: number,
  seed: number,
): WorldDocument {
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  const clampedOctaves = Math.max(1, Math.min(8, Math.round(octaves)));
  const safeScale = scale > 0 ? scale : 1;
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const distance = Math.hypot(x - centerX, z - centerZ);
        if (distance > radius) {
          continue;
        }
        const falloff = 1 - distance / radius;
        const noiseVal = fbmNoise2D(x / safeScale, z / safeScale, clampedOctaves, seed | 0);
        const delta = amplitude * noiseVal * falloff * falloff;
        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        const nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        if (Math.abs(nextHeight - currentHeight) <= 1e-6) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }
  return mutated ? next : world;
}

export function sampleTerrainHeightGrid(
  world: WorldDocument,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  step: number,
): Array<{ x: number; z: number; height: number }> {
  const safeStep = Math.max(0.01, step);
  const results: Array<{ x: number; z: number; height: number }> = [];
  for (let z = minZ; z <= maxZ + 1e-9; z += safeStep) {
    for (let x = minX; x <= maxX + 1e-9; x += safeStep) {
      results.push({ x, z, height: sampleTerrainHeightAtWorldPosition(world, x, z) });
    }
  }
  return results;
}

export function getTerrainRegionStats(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
): {
  sampleCount: number;
  minHeight: number;
  maxHeight: number;
  avgHeight: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
} {
  let sampleCount = 0;
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  let heightSum = 0;

  for (const tile of world.terrain.tiles) {
    for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(world, tile, row, col);
        if (Math.hypot(x - centerX, z - centerZ) > radius) {
          continue;
        }
        const height = tile.heights[row * world.terrain.tileGridSize + col] ?? 0;
        sampleCount += 1;
        if (height < minHeight) minHeight = height;
        if (height > maxHeight) maxHeight = height;
        heightSum += height;
      }
    }
  }

  const bounds = { minX: centerX - radius, maxX: centerX + radius, minZ: centerZ - radius, maxZ: centerZ + radius };
  if (sampleCount === 0) {
    return { sampleCount: 0, minHeight: 0, maxHeight: 0, avgHeight: 0, bounds };
  }
  return { sampleCount, minHeight, maxHeight, avgHeight: heightSum / sampleCount, bounds };
}

export function carveTerrainSpline(
  world: WorldDocument,
  points: Array<{ x: number; z: number }>,
  width: number,
  falloffM: number,
  mode: 'lower' | 'raise' | 'flatten',
  strength: number,
  targetHeight?: number,
): WorldDocument {
  if (points.length < 2) {
    return world;
  }
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  const clampedStrength = clampNumber(strength, 0, 1);
  const halfWidth = Math.max(0, width) * 0.5;
  const safeFalloff = Math.max(0, falloffM);
  const safeTarget = clampNumber(targetHeight ?? 0, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  const totalInfluenceWidth = halfWidth + safeFalloff;
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let nextTile = next.terrain.tiles[tileIndex];
    for (let row = 0; row < next.terrain.tileGridSize; row += 1) {
      for (let col = 0; col < next.terrain.tileGridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);

        let minDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < points.length - 1; i += 1) {
          const d = distanceToSegment(x, z, points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
          if (d < minDist) minDist = d;
        }
        if (minDist > totalInfluenceWidth) {
          continue;
        }

        let influence: number;
        if (minDist <= halfWidth) {
          influence = 1;
        } else {
          const beyond = minDist - halfWidth;
          const t = clampNumber(1 - beyond / Math.max(1e-9, safeFalloff), 0, 1);
          influence = t * t;
        }

        const index = row * next.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[index] ?? 0;
        let nextHeight = currentHeight;

        if (mode === 'flatten') {
          const delta = clampedStrength * influence * (safeTarget - currentHeight);
          nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        } else if (mode === 'lower') {
          if (currentHeight <= safeTarget) {
            continue;
          }
          const delta = clampedStrength * influence * (safeTarget - currentHeight);
          nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        } else {
          if (currentHeight >= safeTarget) {
            continue;
          }
          const delta = clampedStrength * influence * (safeTarget - currentHeight);
          nextHeight = clampNumber(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
        }

        if (Math.abs(nextHeight - currentHeight) <= 1e-6) {
          continue;
        }
        if (nextTile === sourceTile) {
          nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[index] = nextHeight;
        mutated = true;
      }
    }
  }
  return mutated ? next : world;
}

export function getTerrainRampEndpointHeights(ramp: Pick<TerrainRampStencil, 'length' | 'gradePct' | 'targetHeight' | 'targetEdge' | 'targetKind'>): {
  startHeight: number;
  endHeight: number;
  lowHeight: number;
  highHeight: number;
  heightDelta: number;
} {
  const length = Math.max(0.5, ramp.length);
  const rise = length * Math.max(0, ramp.gradePct) / 100;
  const targetHeight = clampNumber(ramp.targetHeight, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  let startHeight = targetHeight;
  let endHeight = targetHeight;

  if (ramp.targetEdge === 'start') {
    endHeight = ramp.targetKind === 'min' ? targetHeight + rise : targetHeight - rise;
  } else {
    startHeight = ramp.targetKind === 'min' ? targetHeight + rise : targetHeight - rise;
  }

  startHeight = clampNumber(startHeight, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  endHeight = clampNumber(endHeight, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
  const lowHeight = Math.min(startHeight, endHeight);
  const highHeight = Math.max(startHeight, endHeight);
  return {
    startHeight,
    endHeight,
    lowHeight,
    highHeight,
    heightDelta: Math.abs(endHeight - startHeight),
  };
}

export function expandWorldTerrain(world: WorldDocument, direction: TerrainExpandDirection): WorldDocument {
  const next = cloneWorldDocument(world);
  const bounds = getTerrainWorldBounds(next);

  if (direction === 'east') {
    const tileX = bounds.maxTileX + 1;
    for (let tileZ = bounds.minTileZ; tileZ <= bounds.maxTileZ; tileZ += 1) {
      if (!getTerrainTile(next, tileX, tileZ)) {
        const source = getTerrainTile(next, tileX - 1, tileZ);
        next.terrain.tiles.push(createExpandedTerrainTile(next, tileX, tileZ, source, direction));
      }
    }
  } else if (direction === 'west') {
    const tileX = bounds.minTileX - 1;
    for (let tileZ = bounds.minTileZ; tileZ <= bounds.maxTileZ; tileZ += 1) {
      if (!getTerrainTile(next, tileX, tileZ)) {
        const source = getTerrainTile(next, tileX + 1, tileZ);
        next.terrain.tiles.push(createExpandedTerrainTile(next, tileX, tileZ, source, direction));
      }
    }
  } else if (direction === 'south') {
    const tileZ = bounds.maxTileZ + 1;
    for (let tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX += 1) {
      if (!getTerrainTile(next, tileX, tileZ)) {
        const source = getTerrainTile(next, tileX, tileZ - 1);
        next.terrain.tiles.push(createExpandedTerrainTile(next, tileX, tileZ, source, direction));
      }
    }
  } else {
    const tileZ = bounds.minTileZ - 1;
    for (let tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX += 1) {
      if (!getTerrainTile(next, tileX, tileZ)) {
        const source = getTerrainTile(next, tileX, tileZ + 1);
        next.terrain.tiles.push(createExpandedTerrainTile(next, tileX, tileZ, source, direction));
      }
    }
  }

  next.terrain.tiles = sortTerrainTiles(next.terrain.tiles);
  return next;
}

export function shrinkWorldTerrain(world: WorldDocument, direction: TerrainExpandDirection): WorldDocument {
  const next = cloneWorldDocument(world);
  const bounds = getTerrainWorldBounds(next);
  const width = bounds.maxTileX - bounds.minTileX + 1;
  const depth = bounds.maxTileZ - bounds.minTileZ + 1;

  if ((direction === 'east' || direction === 'west') && width <= 1) {
    return next;
  }
  if ((direction === 'north' || direction === 'south') && depth <= 1) {
    return next;
  }

  next.terrain.tiles = sortTerrainTiles(next.terrain.tiles.filter((tile) => {
    if (direction === 'east') {
      return tile.tileX !== bounds.maxTileX;
    }
    if (direction === 'west') {
      return tile.tileX !== bounds.minTileX;
    }
    if (direction === 'south') {
      return tile.tileZ !== bounds.maxTileZ;
    }
    return tile.tileZ !== bounds.minTileZ;
  }));

  return next;
}

export function removeTerrainTile(world: WorldDocument, tileX: number, tileZ: number): WorldDocument {
  const next = cloneWorldDocument(world);
  if (next.terrain.tiles.length <= 1) {
    return next;
  }
  if (!getTerrainTile(next, tileX, tileZ)) {
    return next;
  }
  next.terrain.tiles = sortTerrainTiles(next.terrain.tiles.filter((tile) => tile.tileX !== tileX || tile.tileZ !== tileZ));
  return next;
}

export function getAddableTerrainTiles(world: WorldDocument): TerrainTileCoordinate[] {
  const addable = new Map<string, TerrainTileCoordinate>();
  for (const tile of world.terrain.tiles) {
    const candidates: TerrainTileCoordinate[] = [
      { tileX: tile.tileX - 1, tileZ: tile.tileZ },
      { tileX: tile.tileX + 1, tileZ: tile.tileZ },
      { tileX: tile.tileX, tileZ: tile.tileZ - 1 },
      { tileX: tile.tileX, tileZ: tile.tileZ + 1 },
    ];
    for (const candidate of candidates) {
      if (getTerrainTile(world, candidate.tileX, candidate.tileZ)) {
        continue;
      }
      addable.set(getTerrainTileKey(candidate.tileX, candidate.tileZ), candidate);
    }
  }
  return [...addable.values()].sort((a, b) => (a.tileZ - b.tileZ) || (a.tileX - b.tileX));
}

export function addTerrainTile(world: WorldDocument, tileX: number, tileZ: number): WorldDocument {
  const next = cloneWorldDocument(world);
  if (getTerrainTile(next, tileX, tileZ)) {
    return next;
  }
  const tile = createConnectedTerrainTile(next, tileX, tileZ);
  if (!tile) {
    return next;
  }
  next.terrain.tiles = sortTerrainTiles([...next.terrain.tiles, tile]);
  return next;
}

function normalizeTerrain(rawTerrain: Partial<WorldDocument['terrain']> & Partial<LegacyTerrain>): WorldDocument['terrain'] {
  if (Array.isArray(rawTerrain.tiles)) {
    const tileGridSize = rawTerrain.tileGridSize;
    const tileHalfExtentM = rawTerrain.tileHalfExtentM;
    if (typeof tileGridSize !== 'number' || tileGridSize <= 1) {
      throw new Error('World document terrain.tileGridSize is invalid.');
    }
    if (typeof tileHalfExtentM !== 'number' || !Number.isFinite(tileHalfExtentM) || tileHalfExtentM <= 0) {
      throw new Error('World document terrain.tileHalfExtentM is invalid.');
    }
    const expectedHeightCount = tileGridSize * tileGridSize;
    const tiles = rawTerrain.tiles.map((tile) => {
      if (!tile || typeof tile !== 'object') {
        throw new Error('World document terrain tile is invalid.');
      }
      const candidateTile = tile as Partial<WorldTerrainTile>;
      if (typeof candidateTile.tileX !== 'number' || typeof candidateTile.tileZ !== 'number') {
        throw new Error('World document terrain tile coordinates are invalid.');
      }
      if (!Array.isArray(candidateTile.heights) || candidateTile.heights.length !== expectedHeightCount) {
        throw new Error('World document terrain tile heights length does not match tileGridSize.');
      }
      const normalized: WorldTerrainTile = {
        tileX: candidateTile.tileX,
        tileZ: candidateTile.tileZ,
        heights: [...candidateTile.heights],
      };
      if (Array.isArray(candidateTile.materials) && candidateTile.materials.length > 0) {
        normalized.materials = candidateTile.materials;
      }
      if (Array.isArray(candidateTile.materialWeights) && candidateTile.materialWeights.length > 0) {
        normalized.materialWeights = [...candidateTile.materialWeights];
      }
      return normalized;
    });
    if (tiles.length === 0) {
      tiles.push(createEmptyTerrainTile(tileGridSize, 0, 0));
    }
    return {
      tileGridSize,
      tileHalfExtentM,
      tiles: sortTerrainTiles(tiles),
    };
  }

  const gridSize = rawTerrain.gridSize;
  const halfExtentM = rawTerrain.halfExtentM;
  if (typeof gridSize !== 'number' || gridSize <= 1) {
    throw new Error('World document terrain.gridSize is invalid.');
  }
  if (typeof halfExtentM !== 'number' || !Number.isFinite(halfExtentM) || halfExtentM <= 0) {
    throw new Error('World document terrain.halfExtentM is invalid.');
  }
  if (!Array.isArray(rawTerrain.heights) || rawTerrain.heights.length !== gridSize * gridSize) {
    throw new Error('World document terrain heights length does not match grid size.');
  }
  return {
    tileGridSize: gridSize,
    tileHalfExtentM: halfExtentM,
    tiles: [{
      tileX: 0,
      tileZ: 0,
      heights: [...rawTerrain.heights],
    }],
  };
}

function getTerrainTileForWorldPosition(
  world: WorldDocument,
  x: number,
  z: number,
  options?: { allowNearest?: boolean },
): WorldTerrainTile | null {
  const bounds = getTerrainWorldBounds(world);
  const side = terrainTileSideLength(world);
  const tileX = clamp(Math.floor((x + world.terrain.tileHalfExtentM) / side), bounds.minTileX, bounds.maxTileX);
  const tileZ = clamp(Math.floor((z + world.terrain.tileHalfExtentM) / side), bounds.minTileZ, bounds.maxTileZ);
  const exactTile = getTerrainTile(world, tileX, tileZ);
  if (exactTile || !options?.allowNearest) {
    return exactTile;
  }
  return findNearestTerrainTile(world, x, z);
}

function findNearestTerrainTile(world: WorldDocument, x: number, z: number): WorldTerrainTile | null {
  let bestTile: WorldTerrainTile | null = null;
  let bestDistanceSq = Number.POSITIVE_INFINITY;
  for (const tile of world.terrain.tiles) {
    const [centerX, centerZ] = getTerrainTileCenter(world, tile.tileX, tile.tileZ);
    const dx = centerX - x;
    const dz = centerZ - z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestTile = tile;
    }
  }
  return bestTile;
}

function createExpandedTerrainTile(
  world: WorldDocument,
  tileX: number,
  tileZ: number,
  sourceTile: WorldTerrainTile | null,
  direction: TerrainExpandDirection,
): WorldTerrainTile {
  if (!sourceTile) {
    return createEmptyTerrainTile(world.terrain.tileGridSize, tileX, tileZ);
  }

  const heights = new Array(terrainTileSampleCount(world)).fill(0);
  const last = world.terrain.tileGridSize - 1;
  if (direction === 'east' || direction === 'west') {
    const sourceCol = direction === 'east' ? last : 0;
    for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
      const seamHeight = sourceTile.heights[row * world.terrain.tileGridSize + sourceCol] ?? 0;
      for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
        const normalizedDistance = direction === 'east' ? col / last : (last - col) / last;
        heights[row * world.terrain.tileGridSize + col] = taperExpandedHeight(seamHeight, normalizedDistance);
      }
    }
  } else {
    const sourceRow = direction === 'south' ? last : 0;
    for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
      const seamHeight = sourceTile.heights[sourceRow * world.terrain.tileGridSize + col] ?? 0;
      for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
        const normalizedDistance = direction === 'south' ? row / last : (last - row) / last;
        heights[row * world.terrain.tileGridSize + col] = taperExpandedHeight(seamHeight, normalizedDistance);
      }
    }
  }

  return { tileX, tileZ, heights };
}

function taperExpandedHeight(seamHeight: number, normalizedDistance: number): number {
  return seamHeight * getTerrainEdgeInfluence(normalizedDistance);
}

function getTerrainEdgeInfluence(normalizedDistance: number): number {
  const clampedDistance = clampNumber(normalizedDistance / TERRAIN_EXPANSION_TAPER_FRACTION, 0, 1);
  const remainingFalloff = 1 - clampedDistance;
  return remainingFalloff * remainingFalloff;
}

function computeRampFalloff(distanceOutside: number, falloffDistance: number): number {
  if (distanceOutside <= 0) {
    return 1;
  }
  if (falloffDistance <= 0) {
    return 0;
  }
  const normalized = clampNumber(1 - distanceOutside / falloffDistance, 0, 1);
  return normalized * normalized;
}

function createConnectedTerrainTile(world: WorldDocument, tileX: number, tileZ: number): WorldTerrainTile | null {
  const west = getTerrainTile(world, tileX - 1, tileZ);
  const east = getTerrainTile(world, tileX + 1, tileZ);
  const north = getTerrainTile(world, tileX, tileZ - 1);
  const south = getTerrainTile(world, tileX, tileZ + 1);
  if (!west && !east && !north && !south) {
    return null;
  }

  const heights = new Array(terrainTileSampleCount(world)).fill(0);
  const last = world.terrain.tileGridSize - 1;

  for (let row = 0; row < world.terrain.tileGridSize; row += 1) {
    for (let col = 0; col < world.terrain.tileGridSize; col += 1) {
      let weightedHeightSum = 0;
      let weightSum = 0;
      let inverseCombinedInfluence = 1;

      if (west) {
        const weight = getTerrainEdgeInfluence(col / last);
        weightedHeightSum += (west.heights[row * world.terrain.tileGridSize + last] ?? 0) * weight;
        weightSum += weight;
        inverseCombinedInfluence *= 1 - weight;
      }
      if (east) {
        const weight = getTerrainEdgeInfluence((last - col) / last);
        weightedHeightSum += (east.heights[row * world.terrain.tileGridSize] ?? 0) * weight;
        weightSum += weight;
        inverseCombinedInfluence *= 1 - weight;
      }
      if (north) {
        const weight = getTerrainEdgeInfluence(row / last);
        weightedHeightSum += (north.heights[last * world.terrain.tileGridSize + col] ?? 0) * weight;
        weightSum += weight;
        inverseCombinedInfluence *= 1 - weight;
      }
      if (south) {
        const weight = getTerrainEdgeInfluence((last - row) / last);
        weightedHeightSum += (south.heights[col] ?? 0) * weight;
        weightSum += weight;
        inverseCombinedInfluence *= 1 - weight;
      }

      if (weightSum <= 0) {
        heights[row * world.terrain.tileGridSize + col] = 0;
        continue;
      }

      const combinedInfluence = clampNumber(1 - inverseCombinedInfluence, 0, 1);
      const blendedSeamHeight = weightedHeightSum / weightSum;
      heights[row * world.terrain.tileGridSize + col] = blendedSeamHeight * combinedInfluence;
    }
  }

  return { tileX, tileZ, heights };
}

function createEmptyTerrainTile(tileGridSize: number, tileX: number, tileZ: number): WorldTerrainTile {
  return {
    tileX,
    tileZ,
    heights: Array.from({ length: tileGridSize * tileGridSize }, () => 0),
  };
}

function normalizeQuaternion(value: unknown): Quaternion {
  if (
    Array.isArray(value)
    && value.length === 4
    && value.every((component) => typeof component === 'number' && Number.isFinite(component))
  ) {
    return [value[0], value[1], value[2], value[3]];
  }
  return identityQuaternion();
}

function distanceToSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) {
    return Math.hypot(px - ax, pz - az);
  }
  const t = clampNumber(((px - ax) * abx + (pz - az) * abz) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * abx), pz - (az + t * abz));
}

function hashSeed(seed: number, ix: number, iz: number): number {
  let h = (seed ^ (ix * 374761393) ^ (iz * 668265263)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = h ^ (h >>> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function valueNoise2D(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const v00 = hashSeed(seed, ix, iz);
  const v10 = hashSeed(seed, ix + 1, iz);
  const v01 = hashSeed(seed, ix, iz + 1);
  const v11 = hashSeed(seed, ix + 1, iz + 1);
  return lerp(lerp(v00, v10, ux), lerp(v01, v11, ux), uz);
}

function fbmNoise2D(x: number, z: number, octaves: number, seed: number): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i += 1) {
    value += (valueNoise2D(x * frequency, z * frequency, seed + i * 127) - 0.5) * amplitude;
    maxValue += amplitude * 0.5;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return maxValue > 0 ? value / maxValue : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Terrain material helpers
// ---------------------------------------------------------------------------

export function getTerrainMaterials(_world: WorldDocument): TerrainMaterial[] {
  return DEFAULT_TERRAIN_MATERIALS;
}

function smoothstepRange(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Generate material weights for a single tile from geometry normals and positions.
 * Returns a flat Float32Array of length vertexCount * numMaterials.
 */
export function generateAutoMaterialWeightsForTile(
  numMaterials: number,
  tileGridSize: number,
  normals: { getY: (index: number) => number },
  positions: { getX: (index: number) => number; getY: (index: number) => number; getZ: (index: number) => number },
): Float32Array {
  const vertexCount = tileGridSize * tileGridSize;
  const weights = new Float32Array(vertexCount * numMaterials);
  const seed1 = 42;
  const seed2 = 137;
  const seed3 = 271;

  for (let i = 0; i < vertexCount; i += 1) {
    const height = positions.getY(i);
    const worldX = positions.getX(i);
    const worldZ = positions.getZ(i);
    const height01 = clamp((height + 1) * 0.5, 0, 1);
    const slope01 = clamp(1 - normals.getY(i), 0, 1);

    const n1 = fbmNoise2D(worldX * 0.06 + 100, worldZ * 0.06 + 100, 3, seed1) * 0.5 + 0.5;
    const n2 = fbmNoise2D(worldX * 0.09 + 200, worldZ * 0.09 + 200, 3, seed2) * 0.5 + 0.5;
    const n3 = fbmNoise2D(worldX * 0.12 + 300, worldZ * 0.12 + 300, 2, seed3) * 0.5 + 0.5;

    let w0 = smoothstepRange(0.0, 0.35, 1 - slope01) * smoothstepRange(0.0, 0.6, 1 - height01);
    w0 *= 0.7 + n1 * 0.6;
    let w1 = smoothstepRange(0.25, 0.65, slope01) + smoothstepRange(0.8, 1.0, height01) * 0.5;
    w1 *= 0.8 + n2 * 0.4;
    let w2 = smoothstepRange(0.12, 0.4, slope01) * (1 - smoothstepRange(0.65, 1.0, slope01));
    w2 *= 0.6 + n3 * 0.8;
    let w3 = numMaterials > 3 ? smoothstepRange(0.6, 0.85, height01) * (1 - slope01 * 0.7) : 0;
    w3 *= 0.7 + n1 * 0.5;

    const total = w0 + w1 + w2 + w3;
    const base = i * numMaterials;
    if (total > 0) {
      const inv = 1 / total;
      weights[base] = w0 * inv;
      if (numMaterials > 1) weights[base + 1] = w1 * inv;
      if (numMaterials > 2) weights[base + 2] = w2 * inv;
      if (numMaterials > 3) weights[base + 3] = w3 * inv;
    } else {
      weights[base] = 1;
    }
  }
  return weights;
}

/**
 * Get or generate material weights for a tile.
 */
export function getOrGenerateTileMaterialWeights(
  tile: WorldTerrainTile,
  numMaterials: number,
  tileGridSize: number,
  normals: { getY: (index: number) => number },
  positions: { getX: (index: number) => number; getY: (index: number) => number; getZ: (index: number) => number },
): Float32Array {
  const vertexCount = tileGridSize * tileGridSize;
  const expectedLength = vertexCount * numMaterials;
  if (tile.materialWeights && tile.materialWeights.length === expectedLength) {
    return new Float32Array(tile.materialWeights);
  }
  return generateAutoMaterialWeightsForTile(numMaterials, tileGridSize, normals, positions);
}

/**
 * Generate approximate material weights for a tile using only height data.
 * Used to bootstrap the paint brush when no explicit weights exist.
 */
function generateAutoMaterialWeightsFromTileHeights(
  world: WorldDocument,
  tile: WorldTerrainTile,
  numMaterials: number,
): Float32Array {
  const gridSize = world.terrain.tileGridSize;
  const vertexCount = gridSize * gridSize;
  const weights = new Float32Array(vertexCount * numMaterials);
  const cellSize = terrainTileSideLength(world) / (gridSize - 1);
  const seed1 = 42;
  const seed2 = 137;
  const seed3 = 271;

  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const i = row * gridSize + col;
      const h = tile.heights[i] ?? 0;
      const height01 = clamp((h + 1) * 0.5, 0, 1);

      const hL = tile.heights[row * gridSize + Math.max(0, col - 1)] ?? 0;
      const hR = tile.heights[row * gridSize + Math.min(gridSize - 1, col + 1)] ?? 0;
      const hU = tile.heights[Math.max(0, row - 1) * gridSize + col] ?? 0;
      const hD = tile.heights[Math.min(gridSize - 1, row + 1) * gridSize + col] ?? 0;
      const dx = (hR - hL) / (2 * cellSize);
      const dz = (hD - hU) / (2 * cellSize);
      const slope01 = clamp(Math.sqrt(dx * dx + dz * dz) * 0.5, 0, 1);

      const [worldX, worldZ] = getTerrainTileWorldPosition(world, tile, row, col);
      const n1 = fbmNoise2D(worldX * 0.06 + 100, worldZ * 0.06 + 100, 3, seed1) * 0.5 + 0.5;
      const n2 = fbmNoise2D(worldX * 0.09 + 200, worldZ * 0.09 + 200, 3, seed2) * 0.5 + 0.5;
      const n3 = fbmNoise2D(worldX * 0.12 + 300, worldZ * 0.12 + 300, 2, seed3) * 0.5 + 0.5;

      let w0 = smoothstepRange(0.0, 0.35, 1 - slope01) * smoothstepRange(0.0, 0.6, 1 - height01);
      w0 *= 0.7 + n1 * 0.6;
      let w1 = smoothstepRange(0.25, 0.65, slope01) + smoothstepRange(0.8, 1.0, height01) * 0.5;
      w1 *= 0.8 + n2 * 0.4;
      let w2 = smoothstepRange(0.12, 0.4, slope01) * (1 - smoothstepRange(0.65, 1.0, slope01));
      w2 *= 0.6 + n3 * 0.8;
      let w3 = numMaterials > 3 ? smoothstepRange(0.6, 0.85, height01) * (1 - slope01 * 0.7) : 0;
      w3 *= 0.7 + n1 * 0.5;

      const total = w0 + w1 + w2 + w3;
      const base = i * numMaterials;
      if (total > 0) {
        const inv = 1 / total;
        weights[base] = w0 * inv;
        if (numMaterials > 1) weights[base + 1] = w1 * inv;
        if (numMaterials > 2) weights[base + 2] = w2 * inv;
        if (numMaterials > 3) weights[base + 3] = w3 * inv;
      } else {
        weights[base] = 1;
      }
    }
  }
  return weights;
}

/**
 * Paint material brush across all tiles that overlap the brush radius.
 */
export function applyMaterialBrush(
  world: WorldDocument,
  centerX: number,
  centerZ: number,
  radius: number,
  strength: number,
  materialIndex: number,
): WorldDocument {
  const materials = getTerrainMaterials(world);
  const numMaterials = materials.length;
  if (materialIndex < 0 || materialIndex >= numMaterials) return world;

  const gridSize = world.terrain.tileGridSize;
  const vertexCount = gridSize * gridSize;
  const expectedLength = vertexCount * numMaterials;
  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex += 1) {
    const sourceTile = world.terrain.tiles[tileIndex];
    let weights: Float32Array;
    if (sourceTile.materialWeights && sourceTile.materialWeights.length === expectedLength) {
      weights = new Float32Array(sourceTile.materialWeights);
    } else {
      weights = generateAutoMaterialWeightsFromTileHeights(world, sourceTile, numMaterials);
    }

    let tileMutated = false;
    for (let row = 0; row < gridSize; row += 1) {
      for (let col = 0; col < gridSize; col += 1) {
        const [x, z] = getTerrainTileWorldPosition(next, sourceTile, row, col);
        const distance = Math.hypot(x - centerX, z - centerZ);
        if (distance > radius) continue;

        const falloff = 1 - distance / radius;
        const amount = strength * falloff * falloff;
        const base = (row * gridSize + col) * numMaterials;

        weights[base + materialIndex] = clampNumber(weights[base + materialIndex] + amount, 0, 1);

        let total = 0;
        for (let m = 0; m < numMaterials; m += 1) {
          total += weights[base + m];
        }
        if (total > 0) {
          const inv = 1 / total;
          for (let m = 0; m < numMaterials; m += 1) {
            weights[base + m] *= inv;
          }
        }
        tileMutated = true;
      }
    }

    if (tileMutated) {
      next.terrain.tiles[tileIndex] = {
        ...sourceTile,
        heights: [...sourceTile.heights],
        materials,
        materialWeights: Array.from(weights),
      };
      mutated = true;
    }
  }

  return mutated ? next : world;
}
