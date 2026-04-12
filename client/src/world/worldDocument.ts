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

const DEMO_TERRAIN_GRID_SIZE = 129;
const DEMO_TERRAIN_HALF_EXTENT_M = 80;
const DEMO_BALL_PIT_X = 8;
const DEMO_BALL_PIT_Z = 8;
const DEMO_BALL_PIT_WIDTH_M = 8;
const DEMO_BALL_PIT_DEPTH_M = 8;
const DEMO_BALL_PIT_WALL_HEIGHT_M = 3;
const DEMO_BALL_PIT_WALL_THICKNESS_M = 0.35;
const FLAT_CENTER_X = 10;
const FLAT_CENTER_Z = 8;
const FLAT_RADIUS_M = 16;
const BLEND_RADIUS_M = 28;

export const DEFAULT_WORLD_DOCUMENT: WorldDocument = createDefaultWorldDocument();

export function createDefaultWorldDocument(): WorldDocument {
  const heights = buildDefaultTerrainHeights();
  const dynamicEntities: DynamicEntity[] = [];
  let nextDynamicId = 1;
  const innerMinX = DEMO_BALL_PIT_X + 1.5;
  const innerMinZ = DEMO_BALL_PIT_Z + 1.5;
  const spacing = 0.8;
  for (let layer = 0; layer < 2; layer += 1) {
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        dynamicEntities.push({
          id: nextDynamicId,
          kind: 'ball',
          position: [innerMinX + col * spacing, 2 + layer * 0.8, innerMinZ + row * spacing],
          rotation: identityQuaternion(),
          radius: 0.3,
        });
        nextDynamicId += 1;
      }
    }
  }
  dynamicEntities.push({
    id: 100,
    kind: 'box',
    position: [4, 8, 4],
    rotation: identityQuaternion(),
    halfExtents: [0.5, 0.5, 0.5],
  });
  dynamicEntities.push({
    id: 200,
    kind: 'vehicle',
    position: [8, 2, 0],
    rotation: identityQuaternion(),
    vehicleType: 0,
  });

  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: {
      name: 'Demo World',
      description: 'Default authored world for practice and godmode.',
    },
    terrain: {
      gridSize: DEMO_TERRAIN_GRID_SIZE,
      halfExtentM: DEMO_TERRAIN_HALF_EXTENT_M,
      heights,
    },
    staticProps: demoBallPitWallCuboids().map((wall, index) => ({
      id: 1000 + index,
      kind: 'cuboid',
      position: wall.center,
      halfExtents: wall.halfExtents,
      material: 'pit-wall',
    })),
    dynamicEntities,
  };
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
  const normalizedCol = (x + world.terrain.halfExtentM) / side;
  const normalizedRow = (z + world.terrain.halfExtentM) / side;
  const col = normalizedCol * (world.terrain.gridSize - 1);
  const row = normalizedRow * (world.terrain.gridSize - 1);
  const col0 = clamp(Math.floor(col), 0, world.terrain.gridSize - 1);
  const row0 = clamp(Math.floor(row), 0, world.terrain.gridSize - 1);
  const col1 = clamp(col0 + 1, 0, world.terrain.gridSize - 1);
  const row1 = clamp(row0 + 1, 0, world.terrain.gridSize - 1);
  const tx = col - col0;
  const tz = row - row0;
  const h00 = getTerrainHeight(world, row0, col0);
  const h10 = getTerrainHeight(world, row0, col1);
  const h01 = getTerrainHeight(world, row1, col0);
  const h11 = getTerrainHeight(world, row1, col1);
  const hx0 = lerp(h00, h10, tx);
  const hx1 = lerp(h01, h11, tx);
  return lerp(hx0, hx1, tz);
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

function buildDefaultTerrainHeights(): number[] {
  const heights: number[] = [];
  const side = DEMO_TERRAIN_HALF_EXTENT_M * 2;
  const last = DEMO_TERRAIN_GRID_SIZE - 1;
  for (let row = 0; row < DEMO_TERRAIN_GRID_SIZE; row += 1) {
    const z = -DEMO_TERRAIN_HALF_EXTENT_M + side * (row / last);
    for (let col = 0; col < DEMO_TERRAIN_GRID_SIZE; col += 1) {
      const x = -DEMO_TERRAIN_HALF_EXTENT_M + side * (col / last);
      heights.push(sampleTerrainHeight(x, z));
    }
  }
  return heights;
}

function demoBallPitWallCuboids(): Array<{ center: Vec3; halfExtents: Vec3 }> {
  const wallHalfH = DEMO_BALL_PIT_WALL_HEIGHT_M * 0.5;
  const wallThickness = DEMO_BALL_PIT_WALL_THICKNESS_M;
  return [
    {
      center: [
        DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M * 0.5 - 0.5,
        wallHalfH,
        DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M - 0.5,
      ],
      halfExtents: [DEMO_BALL_PIT_WIDTH_M * 0.5, wallHalfH, wallThickness],
    },
    {
      center: [
        DEMO_BALL_PIT_X,
        wallHalfH,
        DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5 - 0.5,
      ],
      halfExtents: [wallThickness, wallHalfH, DEMO_BALL_PIT_DEPTH_M * 0.5],
    },
    {
      center: [
        DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M - 1,
        wallHalfH,
        DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5 - 0.5,
      ],
      halfExtents: [wallThickness, wallHalfH, DEMO_BALL_PIT_DEPTH_M * 0.5],
    },
  ];
}

function sampleTerrainHeight(x: number, z: number): number {
  const base = 0.55 * Math.sin(x * 0.05)
    + 0.35 * Math.cos(z * 0.07)
    + 0.18 * Math.sin((x + z) * 0.035)
    + 0.12 * Math.cos((x - z) * 0.08);

  const dx = x - FLAT_CENTER_X;
  const dz = z - FLAT_CENTER_Z;
  const dist = Math.hypot(dx, dz);
  const blend = smoothstep(FLAT_RADIUS_M, BLEND_RADIUS_M, dist);
  return clampNumber(base * blend, -1, 1);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return 1;
  const t = clampNumber((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
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
