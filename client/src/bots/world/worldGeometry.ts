/**
 * Converts a WorldDocument into raw triangle geometry for navcat.
 */

import type {
  Quaternion,
  StaticProp,
  WorldDocument,
  WorldTerrainTile,
} from '../../world/worldDocument';
import {
  getTerrainTileWorldPosition,
  sortTerrainTiles,
} from '../../world/worldDocument';

export interface BotWorldGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  triangleCount: number;
  vertexCount: number;
}

export function buildWorldGeometry(world: WorldDocument): BotWorldGeometry {
  const tiles = sortTerrainTiles(world.terrain.tiles);
  const tileGridSize = world.terrain.tileGridSize;
  const vertsPerTile = tileGridSize * tileGridSize;
  const trisPerTile = Math.max(0, (tileGridSize - 1) * (tileGridSize - 1) * 2);

  const terrainVerts = tiles.length * vertsPerTile;
  const terrainTris = tiles.length * trisPerTile;

  const propCount = world.staticProps.length;
  const propVerts = propCount * 8;
  const propTris = propCount * 12;

  const totalVerts = terrainVerts + propVerts;
  const totalTris = terrainTris + propTris;

  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalTris * 3);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  let vertexCursor = 0;
  let indexCursor = 0;

  for (const tile of tiles) {
    const tileBaseVertex = vertexCursor;
    writeTerrainTileVertices(world, tile, positions, vertexCursor);

    for (let i = 0; i < vertsPerTile; i += 1) {
      const px = positions[(tileBaseVertex + i) * 3];
      const py = positions[(tileBaseVertex + i) * 3 + 1];
      const pz = positions[(tileBaseVertex + i) * 3 + 2];
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
    }

    for (let row = 0; row < tileGridSize - 1; row += 1) {
      for (let col = 0; col < tileGridSize - 1; col += 1) {
        const a = tileBaseVertex + row * tileGridSize + col;
        const b = tileBaseVertex + row * tileGridSize + col + 1;
        const c = tileBaseVertex + (row + 1) * tileGridSize + col;
        const d = tileBaseVertex + (row + 1) * tileGridSize + col + 1;

        indices[indexCursor + 0] = a;
        indices[indexCursor + 1] = c;
        indices[indexCursor + 2] = b;
        indices[indexCursor + 3] = b;
        indices[indexCursor + 4] = c;
        indices[indexCursor + 5] = d;
        indexCursor += 6;
      }
    }

    vertexCursor += vertsPerTile;
  }

  for (const prop of world.staticProps) {
    if (prop.kind !== 'cuboid') continue;
    const base = vertexCursor;
    writeCuboidVertices(prop, positions, vertexCursor);
    for (let i = 0; i < 8; i += 1) {
      const px = positions[(base + i) * 3];
      const py = positions[(base + i) * 3 + 1];
      const pz = positions[(base + i) * 3 + 2];
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
    }
    writeCuboidIndices(base, indices, indexCursor);
    vertexCursor += 8;
    indexCursor += 36;
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    minZ = 0;
    maxX = 0;
    maxY = 0;
    maxZ = 0;
  }

  return {
    positions,
    indices,
    boundsMin: [minX, minY, minZ],
    boundsMax: [maxX, maxY, maxZ],
    triangleCount: indexCursor / 3,
    vertexCount: vertexCursor,
  };
}

function writeTerrainTileVertices(
  world: WorldDocument,
  tile: WorldTerrainTile,
  out: Float32Array,
  baseVertex: number,
): void {
  const tileGridSize = world.terrain.tileGridSize;
  for (let row = 0; row < tileGridSize; row += 1) {
    for (let col = 0; col < tileGridSize; col += 1) {
      const vi = row * tileGridSize + col;
      const [wx, wz] = getTerrainTileWorldPosition(world, tile, row, col);
      const height = tile.heights[vi] ?? 0;
      const offset = (baseVertex + vi) * 3;
      out[offset + 0] = wx;
      out[offset + 1] = height;
      out[offset + 2] = wz;
    }
  }
}

function writeCuboidVertices(prop: StaticProp, out: Float32Array, baseVertex: number): void {
  const [hx, hy, hz] = prop.halfExtents;
  const [cx, cy, cz] = prop.position;
  const q = prop.rotation;

  for (let corner = 0; corner < 8; corner += 1) {
    const sx = (corner & 1) === 0 ? -hx : hx;
    const sy = (corner & 2) === 0 ? -hy : hy;
    const sz = (corner & 4) === 0 ? -hz : hz;
    const [rx, ry, rz] = rotateByQuaternion(sx, sy, sz, q);
    const offset = (baseVertex + corner) * 3;
    out[offset + 0] = cx + rx;
    out[offset + 1] = cy + ry;
    out[offset + 2] = cz + rz;
  }
}

const CUBOID_TRIANGLES: ReadonlyArray<number> = [
  0, 2, 1,
  1, 2, 3,
  4, 5, 6,
  5, 7, 6,
  0, 4, 2,
  2, 4, 6,
  1, 3, 5,
  3, 7, 5,
  0, 1, 4,
  1, 5, 4,
  2, 6, 3,
  3, 6, 7,
];

function writeCuboidIndices(baseVertex: number, out: Uint32Array, indexCursor: number): void {
  for (let i = 0; i < CUBOID_TRIANGLES.length; i += 1) {
    out[indexCursor + i] = baseVertex + CUBOID_TRIANGLES[i];
  }
}

function rotateByQuaternion(
  x: number,
  y: number,
  z: number,
  q: Quaternion,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  const rx = x + qw * tx + (qy * tz - qz * ty);
  const ry = y + qw * ty + (qz * tx - qx * tz);
  const rz = z + qw * tz + (qx * ty - qy * tx);
  return [rx, ry, rz];
}
