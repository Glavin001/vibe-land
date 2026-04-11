const DEMO_TERRAIN_HALF_EXTENT_M = 80;
const DEMO_BALL_PIT_X = 8;
const DEMO_BALL_PIT_Z = 8;
const DEMO_BALL_PIT_WIDTH_M = 8;
const DEMO_BALL_PIT_DEPTH_M = 8;
const DEMO_BALL_PIT_WALL_HEIGHT_M = 3;
const DEMO_BALL_PIT_WALL_THICKNESS_M = 0.35;

type SeedableSimWorld = {
  addCuboid(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): number;
  seedDemoTerrain?: () => number;
};

function demoBallPitWallCuboids(): Array<{
  center: [number, number, number];
  halfExtents: [number, number, number];
}> {
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
        DEMO_BALL_PIT_X + DEMO_BALL_PIT_WIDTH_M - 1.0,
        wallHalfH,
        DEMO_BALL_PIT_Z + DEMO_BALL_PIT_DEPTH_M * 0.5 - 0.5,
      ],
      halfExtents: [wallThickness, wallHalfH, DEMO_BALL_PIT_DEPTH_M * 0.5],
    },
  ];
}

export function installWasmSimWorldCompat<T extends { prototype: SeedableSimWorld }>(WasmSimWorld: T): void {
  if (typeof WasmSimWorld.prototype.seedDemoTerrain === 'function') {
    return;
  }

  WasmSimWorld.prototype.seedDemoTerrain = function seedDemoTerrain(this: SeedableSimWorld): number {
    const terrainId = this.addCuboid(0, -0.5, 0, DEMO_TERRAIN_HALF_EXTENT_M, 0.5, DEMO_TERRAIN_HALF_EXTENT_M);
    for (const wall of demoBallPitWallCuboids()) {
      this.addCuboid(
        wall.center[0],
        wall.center[1],
        wall.center[2],
        wall.halfExtents[0],
        wall.halfExtents[1],
        wall.halfExtents[2],
      );
    }
    return terrainId;
  };
}
