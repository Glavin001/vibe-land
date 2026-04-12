import defaultWorldDocumentJson from '../../../world/demo-world.world.json';

export const WORLD_DOCUMENT_VERSION = 1;
export const DEFAULT_WORLD_HISTORY_LIMIT = 3;

export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];

export type WorldDocument = {
  version: number;
  meta: {
    name: string;
    description: string;
  };
  terrain: {
    gridSize: number;
    halfExtentM: number;
    heights: number[];
  };
  staticProps: StaticProp[];
  dynamicEntities: DynamicEntity[];
};

export type StaticProp = {
  id: number;
  kind: 'cuboid';
  position: Vec3;
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
  const candidate = raw as Partial<WorldDocument>;
  if (!candidate.terrain || !Array.isArray(candidate.terrain.heights)) {
    throw new Error('World document terrain is missing.');
  }
  if (typeof candidate.terrain.gridSize !== 'number' || candidate.terrain.gridSize <= 1) {
    throw new Error('World document terrain.gridSize is invalid.');
  }
  if (candidate.terrain.heights.length !== candidate.terrain.gridSize * candidate.terrain.gridSize) {
    throw new Error('World document terrain heights length does not match grid size.');
  }
  if (!Array.isArray(candidate.staticProps) || !Array.isArray(candidate.dynamicEntities)) {
    throw new Error('World document entity arrays are missing.');
  }
  return candidate as WorldDocument;
}

export function serializeWorldDocument(world: WorldDocument): string {
  return JSON.stringify(world, null, 2);
}

export function cloneWorldDocument(world: WorldDocument): WorldDocument {
  if (typeof structuredClone === 'function') {
    return structuredClone(world);
  }
  return JSON.parse(JSON.stringify(world)) as WorldDocument;
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

export function getTerrainHeight(world: WorldDocument, row: number, col: number): number {
  return world.terrain.heights[row * world.terrain.gridSize + col] ?? 0;
}

export function getTerrainWorldPosition(world: WorldDocument, row: number, col: number): [number, number] {
  const last = world.terrain.gridSize - 1;
  const side = world.terrain.halfExtentM * 2;
  const x = -world.terrain.halfExtentM + side * (col / last);
  const z = -world.terrain.halfExtentM + side * (row / last);
  return [x, z];
}

export function sampleTerrainHeightAtWorldPosition(world: WorldDocument, x: number, z: number): number {
  const side = world.terrain.halfExtentM * 2;
  const maxIndex = world.terrain.gridSize - 1;
  const maxCell = world.terrain.gridSize - 2;
  const col = clamp(((x + world.terrain.halfExtentM) / side) * maxIndex, 0, maxIndex);
  const row = clamp(((z + world.terrain.halfExtentM) / side) * maxIndex, 0, maxIndex);
  const cellCol = clamp(Math.floor(col), 0, maxCell);
  const cellRow = clamp(Math.floor(row), 0, maxCell);
  const u = col - cellCol;
  const v = row - cellRow;
  const h00 = getTerrainHeight(world, cellRow, cellCol);
  const h10 = getTerrainHeight(world, cellRow, cellCol + 1);
  const h01 = getTerrainHeight(world, cellRow + 1, cellCol);
  const h11 = getTerrainHeight(world, cellRow + 1, cellCol + 1);
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
): WorldDocument {
  const next = cloneWorldDocument(world);
  const direction = mode === 'raise' ? 1 : -1;
  for (let row = 0; row < next.terrain.gridSize; row += 1) {
    for (let col = 0; col < next.terrain.gridSize; col += 1) {
      const [x, z] = getTerrainWorldPosition(next, row, col);
      const distance = Math.hypot(x - centerX, z - centerZ);
      if (distance > radius) {
        continue;
      }
      const falloff = 1 - distance / radius;
      const delta = strength * falloff * falloff * direction;
      const index = row * next.terrain.gridSize + col;
      next.terrain.heights[index] = clampNumber(next.terrain.heights[index] + delta, -10, 50);
    }
  }
  return next;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
