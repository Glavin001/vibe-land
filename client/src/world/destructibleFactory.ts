import type { Chunk, Quaternion, Vec3 } from './worldDocument';
import { FRACTURE_BRICK_EDGE_M, identityQuaternion } from './worldDocument';

// Mirror of `WallOptions::default()` / `TowerOptions::default()` layouts used
// by the Rust factory expansion. Keep in sync with
// `shared/src/destructibles_native_fallback.rs`.
const WALL_SPAN_M = 6.0;
const WALL_HEIGHT_M = 3.0;
const WALL_THICKNESS_M = 0.32;
const WALL_SPAN_SEGMENTS = 12;
const WALL_HEIGHT_SEGMENTS = 6;
const WALL_LAYERS = 1;

const TOWER_SIDE = 4;
const TOWER_STORIES = 7;
const TOWER_SPACING_X = 0.5;
const TOWER_SPACING_Y = 0.5;
const TOWER_SPACING_Z = 0.5;

export function expandFactoryKindToChunks(kind: 'wall' | 'tower'): Chunk[] {
  return kind === 'wall' ? buildWallChunks() : buildTowerChunks();
}

export function buildWallChunks(): Chunk[] {
  const cellX = WALL_SPAN_M / WALL_SPAN_SEGMENTS;
  const cellY = WALL_HEIGHT_M / WALL_HEIGHT_SEGMENTS;
  const cellZ = WALL_THICKNESS_M / WALL_LAYERS;
  const originX = -WALL_SPAN_M * 0.5 + cellX * 0.5;
  const originY = cellY * 0.5;
  const halfExtents: Vec3 = [cellX * 0.5, cellY * 0.5, cellZ * 0.5];
  const out: Chunk[] = [];
  for (let ix = 0; ix < WALL_SPAN_SEGMENTS; ix += 1) {
    for (let iy = 0; iy < WALL_HEIGHT_SEGMENTS; iy += 1) {
      for (let iz = 0; iz < WALL_LAYERS; iz += 1) {
        const position: Vec3 = [
          originX + ix * cellX,
          originY + iy * cellY,
          (iz - (WALL_LAYERS - 1) * 0.5) * cellZ,
        ];
        const chunk: Chunk = {
          shape: 'box',
          position,
          rotation: identityQuaternion(),
          halfExtents: [...halfExtents] as Vec3,
        };
        if (iy === 0) chunk.anchor = true;
        out.push(chunk);
      }
    }
  }
  return out;
}

export function buildTowerChunks(): Chunk[] {
  const totalRows = TOWER_STORIES + 1;
  const halfExtents: Vec3 = [
    TOWER_SPACING_X * 0.5,
    TOWER_SPACING_Y * 0.5,
    TOWER_SPACING_Z * 0.5,
  ];
  const sideCenter = (TOWER_SIDE - 1) * 0.5;
  const out: Chunk[] = [];
  for (let iz = 0; iz < TOWER_SIDE; iz += 1) {
    for (let iy = 0; iy < totalRows; iy += 1) {
      for (let ix = 0; ix < TOWER_SIDE; ix += 1) {
        const position: Vec3 = [
          (ix - sideCenter) * TOWER_SPACING_X,
          (iy - 1) * TOWER_SPACING_Y,
          (iz - sideCenter) * TOWER_SPACING_Z,
        ];
        const chunk: Chunk = {
          shape: 'box',
          position,
          rotation: identityQuaternion(),
          halfExtents: [...halfExtents] as Vec3,
        };
        if (iy === 0) chunk.anchor = true;
        out.push(chunk);
      }
    }
  }
  return out;
}

/**
 * Subdivide authored chunks into brick-sized sub-chunks so the Blast
 * auto-bonder can wire them together into a rich bond network.
 *
 * Box chunks are split into an axis-aligned grid where each cell is at
 * least `brickEdge` on every axis. Sphere/capsule chunks pass through
 * unchanged (only their box neighbors will bond into them).
 *
 * Mass overrides are distributed across sub-bricks so total mass stays
 * constant. Anchor / material flags are inherited by every sub-brick.
 */
export function fractureChunks(chunks: readonly Chunk[], brickEdge = FRACTURE_BRICK_EDGE_M): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    if (chunk.shape !== 'box' || !chunk.halfExtents) {
      out.push(chunk);
      continue;
    }
    const [hx, hy, hz] = chunk.halfExtents;
    const cellsX = Math.max(1, Math.floor((hx * 2) / brickEdge));
    const cellsY = Math.max(1, Math.floor((hy * 2) / brickEdge));
    const cellsZ = Math.max(1, Math.floor((hz * 2) / brickEdge));
    if (cellsX === 1 && cellsY === 1 && cellsZ === 1) {
      out.push(chunk);
      continue;
    }
    const cellHx = hx / cellsX;
    const cellHy = hy / cellsY;
    const cellHz = hz / cellsZ;
    const parentRot = chunk.rotation;
    const parentPos = chunk.position;
    const totalCells = cellsX * cellsY * cellsZ;
    for (let ix = 0; ix < cellsX; ix += 1) {
      for (let iy = 0; iy < cellsY; iy += 1) {
        for (let iz = 0; iz < cellsZ; iz += 1) {
          const localCenter: Vec3 = [
            -hx + cellHx * (2 * ix + 1),
            -hy + cellHy * (2 * iy + 1),
            -hz + cellHz * (2 * iz + 1),
          ];
          const rotated = rotateVec3ByQuaternion(localCenter, parentRot);
          const sub: Chunk = {
            shape: 'box',
            position: [
              parentPos[0] + rotated[0],
              parentPos[1] + rotated[1],
              parentPos[2] + rotated[2],
            ] as Vec3,
            rotation: [...parentRot] as Quaternion,
            halfExtents: [cellHx, cellHy, cellHz] as Vec3,
          };
          if (chunk.material !== undefined) sub.material = chunk.material;
          if (chunk.anchor === true) sub.anchor = true;
          if (typeof chunk.mass === 'number') sub.mass = chunk.mass / totalCells;
          out.push(sub);
        }
      }
    }
  }
  return out;
}

function rotateVec3ByQuaternion(v: Vec3, q: Quaternion): Vec3 {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}
