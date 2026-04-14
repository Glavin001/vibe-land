/**
 * Converts a {@link WorldDocument} into raw triangle geometry suitable for
 * feeding into navcat's navmesh builders.
 *
 * Produces two typed arrays:
 * - `positions`: `Float32Array` of interleaved `[x, y, z, ...]` vertex coords
 * - `indices`:   `Uint32Array` of triangle indices (CCW when looking from +Y)
 *
 * Zero external dependencies (no THREE, no React) so it runs unchanged under
 * Node for the load-test workers as well as in the browser LoadTest page.
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
  /** Interleaved xyz floats, length = vertexCount * 3. */
  positions: Float32Array;
  /** Triangle indices, length = triangleCount * 3. */
  indices: Uint32Array;
  /** Axis-aligned bounding box min corner, meters. */
  boundsMin: [number, number, number];
  /** Axis-aligned bounding box max corner, meters. */
  boundsMax: [number, number, number];
  /** Number of triangles emitted (for diagnostics / tests). */
  triangleCount: number;
  /** Number of unique vertices emitted (for diagnostics / tests). */
  vertexCount: number;
}

/**
 * Builds the combined triangle soup for terrain + static cuboid props.
 *
 * Dynamic entities are intentionally ignored — they move at runtime and the
 * server-side crowd avoidance / physics handles those interactions.
 */
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

  // Terrain tiles ---------------------------------------------------------
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

        // Two triangles per quad, wound so normals point +Y.
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

  // Static cuboid props ---------------------------------------------------
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

/**
 * Writes the 8 corner vertices of a rotated cuboid into `out`.
 *
 * The 8 corners are enumerated with a 3-bit mask (x,y,z) so
 * {@link writeCuboidIndices} below can use a fixed triangle table.
 */
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

// Corner indexing (bit 0 = x, bit 1 = y, bit 2 = z; 0 = -, 1 = +)
//  0: -x -y -z
//  1: +x -y -z
//  2: -x +y -z
//  3: +x +y -z
//  4: -x -y +z
//  5: +x -y +z
//  6: -x +y +z
//  7: +x +y +z
// Triangles wound CCW as seen from outside the box.
const CUBOID_TRIANGLES: ReadonlyArray<number> = [
  // -Z face (normal -Z): corners 0,1,2,3
  0, 2, 1,
  1, 2, 3,
  // +Z face (normal +Z): corners 4,5,6,7
  4, 5, 6,
  5, 7, 6,
  // -X face (normal -X): corners 0,2,4,6
  0, 4, 2,
  2, 4, 6,
  // +X face (normal +X): corners 1,3,5,7
  1, 3, 5,
  3, 7, 5,
  // -Y face (normal -Y): corners 0,1,4,5
  0, 1, 4,
  1, 5, 4,
  // +Y face (normal +Y): corners 2,3,6,7
  2, 6, 3,
  3, 6, 7,
];

function writeCuboidIndices(baseVertex: number, out: Uint32Array, indexCursor: number): void {
  for (let i = 0; i < CUBOID_TRIANGLES.length; i += 1) {
    out[indexCursor + i] = baseVertex + CUBOID_TRIANGLES[i];
  }
}

/**
 * Rotates a local-space vector `(x, y, z)` by the quaternion `q = [x,y,z,w]`.
 *
 * Uses the standard `v' = q * v * q^-1` expansion without allocating any
 * intermediate objects, so this function is cheap enough to call in the hot
 * loop of {@link writeCuboidVertices}.
 */
function rotateByQuaternion(
  x: number,
  y: number,
  z: number,
  q: Quaternion,
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  // t = 2 * (q.xyz × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  // v' = v + qw * t + q.xyz × t
  const rx = x + qw * tx + (qy * tz - qz * ty);
  const ry = y + qw * ty + (qz * tx - qx * tz);
  const rz = z + qw * tz + (qx * ty - qy * tx);
  return [rx, ry, rz];
}
