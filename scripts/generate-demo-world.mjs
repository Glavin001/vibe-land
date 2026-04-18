import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WORLD_DOCUMENT_VERSION = 2;
const DEMO_TERRAIN_GRID_SIZE = 129;
const DEMO_TERRAIN_HALF_EXTENT_M = 80;
const DEMO_BALL_PIT_X = 8;
const DEMO_BALL_PIT_Z = 8;
const DEMO_BALL_PIT_WIDTH_M = 8;
const DEMO_BALL_PIT_DEPTH_M = 8;
const DEMO_BALL_PIT_WALL_HEIGHT_M = 3;
const DEMO_BALL_PIT_WALL_THICKNESS_M = 0.35;
const DEMO_BALL_PIT_BALL_BASE_Y = 4.0;
const FLAT_CENTER_X = 10;
const FLAT_CENTER_Z = 8;
const FLAT_RADIUS_M = 16;
const BLEND_RADIUS_M = 28;

function identityQuaternion() {
  return [0, 0, 0, 1];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sampleTerrainHeight(x, z) {
  const base = 0.55 * Math.sin(x * 0.05)
    + 0.35 * Math.cos(z * 0.07)
    + 0.18 * Math.sin((x + z) * 0.035)
    + 0.12 * Math.cos((x - z) * 0.08);

  const dx = x - FLAT_CENTER_X;
  const dz = z - FLAT_CENTER_Z;
  const dist = Math.hypot(dx, dz);
  const blend = smoothstep(FLAT_RADIUS_M, BLEND_RADIUS_M, dist);
  return clamp(base * blend, -1, 1);
}

function buildDefaultTerrainHeights() {
  const heights = [];
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

function demoBallPitWallCuboids() {
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

function demoBallPitBalls() {
  const radius = 0.3;
  const innerMinX = DEMO_BALL_PIT_X + 1.5;
  const innerMinZ = DEMO_BALL_PIT_Z + 1.5;
  const spacing = 0.8;
  const cols = 5;
  const rows = 5;
  const layers = 2;
  const balls = [];
  let nextId = 1;

  for (let layer = 0; layer < layers; layer += 1) {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        balls.push({
          id: nextId,
          kind: 'ball',
          position: [
            innerMinX + col * spacing,
            DEMO_BALL_PIT_BALL_BASE_Y + layer * 0.8,
            innerMinZ + row * spacing,
          ],
          rotation: identityQuaternion(),
          radius,
        });
        nextId += 1;
      }
    }
  }

  return balls;
}

function createDemoWorldDocument() {
  return {
    version: WORLD_DOCUMENT_VERSION,
    meta: {
      name: 'Demo World',
      description: 'Default authored world for practice and godmode.',
    },
    terrain: {
      tileGridSize: DEMO_TERRAIN_GRID_SIZE,
      tileHalfExtentM: DEMO_TERRAIN_HALF_EXTENT_M,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights: buildDefaultTerrainHeights(),
      }],
    },
    staticProps: demoBallPitWallCuboids().map((wall, index) => ({
      id: 1000 + index,
      kind: 'cuboid',
      position: wall.center,
      rotation: identityQuaternion(),
      halfExtents: wall.halfExtents,
      material: 'pit-wall',
    })),
    dynamicEntities: [
      ...demoBallPitBalls(),
      {
        id: 100,
        kind: 'box',
        position: [4, 8, 4],
        rotation: identityQuaternion(),
        halfExtents: [0.5, 0.5, 0.5],
      },
      {
        id: 200,
        kind: 'vehicle',
        position: [8, 2, 0],
        rotation: identityQuaternion(),
        vehicleType: 1,
      },
      {
        id: 1003,
        kind: 'vehicle',
        position: [0, 0.8552152628004638, 0],
        rotation: identityQuaternion(),
        vehicleType: 0,
      },
    ],
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.resolve(__dirname, '../worlds/trail.world.json');
const world = createDemoWorldDocument();
fs.writeFileSync(outputPath, `${JSON.stringify(world, null, 2)}\n`);
process.stdout.write(`Wrote ${outputPath}\n`);
