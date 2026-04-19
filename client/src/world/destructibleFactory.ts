import type { Chunk, Vec3 } from './worldDocument';
import { identityQuaternion } from './worldDocument';

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
