import defaultWorldDocumentJson from '../../../worlds/trail.world.json';

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
  kind: 'box' | 'ball' | 'vehicle';
  position: Vec3;
  rotation: Quaternion;
  halfExtents?: Vec3;
  radius?: number;
  vehicleType?: number;
};

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
  };
  if (!candidate.terrain) {
    throw new Error('World document terrain is missing.');
  }
  if (!Array.isArray(candidate.staticProps) || !Array.isArray(candidate.dynamicEntities)) {
    throw new Error('World document entity arrays are missing.');
  }

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
  };
}

export function serializeWorldDocument(world: WorldDocument): string {
  return JSON.stringify(
    {
      ...world,
      version: WORLD_DOCUMENT_VERSION,
      terrain: {
        tileGridSize: world.terrain.tileGridSize,
        tileHalfExtentM: world.terrain.tileHalfExtentM,
        tiles: sortTerrainTiles(world.terrain.tiles).map((tile) => ({
          tileX: tile.tileX,
          tileZ: tile.tileZ,
          heights: [...tile.heights],
        })),
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
  return Math.max(highestStatic, highestDynamic) + 1;
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

export function getMinimumDynamicEntityY(world: WorldDocument, entity: Pick<DynamicEntity, 'kind' | 'position' | 'halfExtents' | 'radius'>): number {
  const terrainY = sampleTerrainHeightAtWorldPosition(world, entity.position[0], entity.position[2]);
  if (entity.kind === 'box') {
    return terrainY + (entity.halfExtents?.[1] ?? 0.5) + 0.05;
  }
  if (entity.kind === 'ball') {
    return terrainY + (entity.radius ?? 0.5) + 0.05;
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
      return {
        tileX: candidateTile.tileX,
        tileZ: candidateTile.tileZ,
        heights: [...candidateTile.heights],
      };
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
