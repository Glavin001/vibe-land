// A deterministic fractured city, sized on demand.
//
// This exists because the live /city cannot be A/B'd. Two runs at the same
// heading measured 4 and 28 draw calls: the server's world keeps settling,
// debris keeps moving, and the manifest is whatever the last demolition left
// behind. Any "optimization" judged against that is judged against noise.
//
// So the bench generates its own city from a seed. Same shapes the real one
// draws (boxes for structural members, convex hulls for fracture shards, hulls
// deduplicated because one pack is stamped many times), same cell partitioning,
// same write policy -- but reproducible to the draw call, and scalable past
// what the physics server can simulate. 24k chunks is what downtown happens to
// be, not the ceiling players will hit.
//
// No WebGL here: shape and layout decisions are plain data so they can be unit
// tested, exactly as chunkGeometry.ts is separate from the React layer.

import type { ChunkShape } from '../city/chunkGeometry';

export type SyntheticCity = {
  chunkCount: number;
  /** Rest pose per chunk, world space. `[i*3 .. i*3+2]`. */
  positions: Float32Array;
  /** Render scale per chunk: box extents, or 1,1,1 for hulls (already metric). */
  scales: Float32Array;
  /** Bounding radius per chunk, for the batch spheres. */
  radii: Float32Array;
  /** What to draw. Hull entries share `key` across every reuse of a shape. */
  shapes: ChunkShape[];
  /**
   * Chunk -> body. Bodies are the unit that moves and the unit the write loop
   * strides on, so a bench where every chunk is its own body would understate
   * the cost of the real thing (a body carries several chunks and writes them
   * together).
   */
  bodyOfChunk: Int32Array;
  bodyCount: number;
  /** Chunk indices owned by each body, flattened; `bodyStart[b]..bodyStart[b+1]`. */
  bodyChunks: Int32Array;
  bodyStart: Int32Array;
  towerCount: number;
  /** Footprint of the whole city, for camera framing. */
  extentM: number;
};

export type SyntheticCityOptions = {
  /** Target chunk count. Rounded up to fill whole floors. */
  chunks: number;
  /** How many buildings to spread them across. */
  towers?: number;
  /** Share of chunks drawn as convex hulls rather than boxes. */
  hullFraction?: number;
  /** Distinct hull shapes in the pool. Reuse is what makes hulls affordable. */
  hullVariants?: number;
  seed?: number;
};

/**
 * Chunks per floor. 4x4 is the shape of an authored floor slab in the real
 * packs -- a grid of members rather than one slab -- and it matters here only
 * because it sets how many chunks share a cell.
 */
const FLOOR_W = 4;
const FLOOR_D = 4;
/** Edge of a single chunk, metres. */
const CHUNK_M = 1.5;
/** Storey height, metres. */
const FLOOR_M = 1.6;
/** Centre-to-centre tower spacing. Wide enough that towers land in own cells. */
const TOWER_SPACING_M = 22;
/** Chunks per body. Fracture islands are small clusters, not single pieces. */
const CHUNKS_PER_BODY = 4;

/**
 * Deterministic PRNG (mulberry32).
 *
 * Math.random would make the bench unreproducible, which is the one property
 * it exists to have.
 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A convex shard, as an unordered point cloud around its own centroid.
 *
 * Centroid-relative to match the manifest's convention, so a hull drops
 * straight into the transform slot a unit cube would have occupied.
 */
function makeHullPoints(random: () => number, radiusM: number): Float32Array {
  const pointCount = 8 + Math.floor(random() * 5);
  const points = new Float32Array(pointCount * 3);
  for (let i = 0; i < pointCount; i += 1) {
    // Direction by rejection-free spherical sampling, radius jittered so the
    // hull is a lumpy shard rather than a faceted ball.
    const z = random() * 2 - 1;
    const theta = random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const scale = radiusM * (0.55 + random() * 0.45);
    points[i * 3] = Math.cos(theta) * r * scale;
    points[i * 3 + 1] = z * scale;
    points[i * 3 + 2] = Math.sin(theta) * r * scale;
  }
  return points;
}

/**
 * Builds the city.
 *
 * Towers default to roughly one per 900 chunks, which keeps a tower near the
 * ~10-storey height of the real downtown pack instead of growing a single
 * kilometre-high spire as the target count rises. The distinction is not
 * cosmetic: cell partitioning and frustum culling both key on footprint, and a
 * city that grows upward instead of outward would never exercise them.
 */
export function buildSyntheticCity(options: SyntheticCityOptions): SyntheticCity {
  const targetChunks = Math.max(FLOOR_W * FLOOR_D, Math.floor(options.chunks));
  const towerCount = Math.max(1, options.towers ?? Math.ceil(targetChunks / 900));
  const hullFraction = Math.min(1, Math.max(0, options.hullFraction ?? 0.5));
  const hullVariants = Math.max(1, options.hullVariants ?? 32);
  const random = makeRandom(options.seed ?? 1);

  const perFloor = FLOOR_W * FLOOR_D;
  const floorsPerTower = Math.max(1, Math.round(targetChunks / (towerCount * perFloor)));
  const chunkCount = towerCount * floorsPerTower * perFloor;

  // The hull pool. Built once and shared, because that is what the real
  // manifest does -- the same shard recurs once per stamp of the pack, and
  // deduplicating on the point set turns thousands of hull uploads into tens.
  const hullPool: Array<{ key: string; points: Float32Array; radius: number }> = [];
  for (let i = 0; i < hullVariants; i += 1) {
    const radius = CHUNK_M * (0.35 + random() * 0.3);
    const points = makeHullPoints(random, radius);
    hullPool.push({ key: `bench-hull-${i}`, points, radius });
  }

  const positions = new Float32Array(chunkCount * 3);
  const scales = new Float32Array(chunkCount * 3);
  const radii = new Float32Array(chunkCount);
  const shapes = new Array<ChunkShape>(chunkCount);
  const bodyOfChunk = new Int32Array(chunkCount);

  // Towers on a square grid centred on the origin.
  const gridSide = Math.ceil(Math.sqrt(towerCount));
  const originOffset = ((gridSide - 1) * TOWER_SPACING_M) / 2;

  let chunk = 0;
  for (let tower = 0; tower < towerCount; tower += 1) {
    const tx = (tower % gridSide) * TOWER_SPACING_M - originOffset;
    const tz = Math.floor(tower / gridSide) * TOWER_SPACING_M - originOffset;
    for (let floor = 0; floor < floorsPerTower; floor += 1) {
      for (let cell = 0; cell < perFloor; cell += 1) {
        const ix = cell % FLOOR_W;
        const iz = Math.floor(cell / FLOOR_W);
        positions[chunk * 3] = tx + (ix - (FLOOR_W - 1) / 2) * CHUNK_M;
        positions[chunk * 3 + 1] = 0.5 * CHUNK_M + floor * FLOOR_M;
        positions[chunk * 3 + 2] = tz + (iz - (FLOOR_D - 1) / 2) * CHUNK_M;

        if (random() < hullFraction) {
          const hull = hullPool[Math.floor(random() * hullPool.length)];
          shapes[chunk] = { kind: 'hull', key: hull.key, points: hull.points };
          scales[chunk * 3] = 1;
          scales[chunk * 3 + 1] = 1;
          scales[chunk * 3 + 2] = 1;
          radii[chunk] = hull.radius;
        } else {
          const sx = CHUNK_M * (0.7 + random() * 0.5);
          const sy = FLOOR_M * (0.7 + random() * 0.4);
          const sz = CHUNK_M * (0.7 + random() * 0.5);
          shapes[chunk] = { kind: 'box', scale: [sx, sy, sz] };
          scales[chunk * 3] = sx;
          scales[chunk * 3 + 1] = sy;
          scales[chunk * 3 + 2] = sz;
          radii[chunk] = 0.5 * Math.hypot(sx, sy, sz);
        }
        chunk += 1;
      }
    }
  }

  // Bodies group consecutive chunks, so a body's chunks share a floor and
  // therefore a cell -- the same locality the real islands have, and the
  // property the batch-keyed stagger depends on.
  const bodyCount = Math.ceil(chunkCount / CHUNKS_PER_BODY);
  const bodyStart = new Int32Array(bodyCount + 1);
  const bodyChunks = new Int32Array(chunkCount);
  for (let i = 0; i < chunkCount; i += 1) {
    bodyOfChunk[i] = Math.floor(i / CHUNKS_PER_BODY);
    bodyChunks[i] = i;
  }
  for (let b = 0; b <= bodyCount; b += 1) {
    bodyStart[b] = Math.min(chunkCount, b * CHUNKS_PER_BODY);
  }

  return {
    chunkCount,
    positions,
    scales,
    radii,
    shapes,
    bodyOfChunk,
    bodyCount,
    bodyChunks,
    bodyStart,
    towerCount,
    extentM: gridSide * TOWER_SPACING_M,
  };
}
