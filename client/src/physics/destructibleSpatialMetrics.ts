import type { Destructible } from '../world/worldDocument';

/**
 * Flat transform row layout shared by the wasm destructible bridge and the
 * browser renderer:
 * `[destructibleId, chunkIndex, px, py, pz, qx, qy, qz, qw, present, _pad]`.
 *
 * The Playwright repro consumes the same buffer the renderer does so that
 * overlap failures are measured from the browser-visible chunk poses rather
 * than from a separate physics-only diagnostic path.
 */
export const DESTRUCTIBLE_CHUNK_TRANSFORM_STRIDE = 11;

const SIGNIFICANT_OVERLAP_EPSILON_M = 0.05;
const NEAR_COINCIDENT_DISTANCE_EPSILON_M = 0.1;

const CHUNK_HALF_EXTENTS_BY_KIND: Record<Destructible['kind'], [number, number, number]> = {
  wall: [0.25, 0.25, 0.16],
  tower: [0.25, 0.25, 0.25],
};

type ChunkMetricsSample = {
  destructibleId: number;
  chunkIndex: number;
  center: [number, number, number];
  aabbHalfExtents: [number, number, number];
};

export type DestructibleOverlapSample = {
  destructibleId: number;
  leftChunkIndex: number;
  rightChunkIndex: number;
  penetrationM: number;
  centerDistanceM: number;
  leftCenter: [number, number, number];
  rightCenter: [number, number, number];
};

/**
 * Spatial-separation summary for destructible chunks as seen by the browser.
 *
 * `significantOverlapPairCount` is the key signal for the current wall
 * fracture bug: it should be zero once debris chunks are preserving unique
 * occupied space after fracture.
 *
 * `sampleOverlapPairs` exists to make failing E2E output self-contained:
 * when the browser test fails it prints a small set of representative chunk
 * pairs so the fix can focus on the concrete post-fracture pose pattern.
 */
export type DestructibleSpatialMetrics = {
  overlapPairCount: number;
  significantOverlapPairCount: number;
  maxOverlapPenetrationM: number;
  nearCoincidentPairCount: number;
  minCenterDistanceM: number;
  lowestChunkBottomY: number;
  sampleOverlapPairs: DestructibleOverlapSample[];
};

/**
 * Converts an oriented chunk box into world-axis-aligned half extents so the
 * browser can approximate overlap using only the chunk pose buffer.
 *
 * This is intentionally an approximation layer for E2E diagnostics. It is
 * not the authoritative collision system; Rapier still owns the real contact
 * resolution. The purpose here is to detect when browser-visible chunk poses
 * imply obvious interpenetration after fracture.
 */
function quaternionToWorldAabbHalfExtents(
  halfExtents: [number, number, number],
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number] {
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;

  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);

  const [hx, hy, hz] = halfExtents;
  return [
    Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz,
    Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz,
    Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz,
  ];
}

/**
 * Computes browser-facing destructible overlap diagnostics from the live
 * chunk transform buffer.
 *
 * Why this exists:
 * - the user-reported bug is visible in the browser after driving into the
 *   practice wall
 * - a wasm-only unit test is not enough to prove the browser path matches
 *   what the player sees
 * - Playwright needs a compact, serializable signal that can fail with
 *   useful context
 *
 * What a future fix should make true:
 * - `significantOverlapPairCount === 0`
 * - `nearCoincidentPairCount === 0`
 * - representative overlap samples disappear after the fracture settles
 */
export function computeDestructibleSpatialMetrics(
  destructibles: ReadonlyArray<Pick<Destructible, 'id' | 'kind'>>,
  rawTransforms: ArrayLike<number> | null | undefined,
): DestructibleSpatialMetrics {
  const transforms = Array.from(rawTransforms ?? []);
  if (transforms.length < DESTRUCTIBLE_CHUNK_TRANSFORM_STRIDE) {
    return {
      overlapPairCount: 0,
      significantOverlapPairCount: 0,
      maxOverlapPenetrationM: 0,
      nearCoincidentPairCount: 0,
      minCenterDistanceM: -1,
      lowestChunkBottomY: 0,
      sampleOverlapPairs: [],
    };
  }

  const kindById = new Map<number, Destructible['kind']>();
  for (const destructible of destructibles) {
    kindById.set(destructible.id, destructible.kind);
  }

  const samplesById = new Map<number, ChunkMetricsSample[]>();
  let lowestChunkBottomY = Number.POSITIVE_INFINITY;

  for (let base = 0; base <= transforms.length - DESTRUCTIBLE_CHUNK_TRANSFORM_STRIDE; base += DESTRUCTIBLE_CHUNK_TRANSFORM_STRIDE) {
    const presentFlag = transforms[base + 9] ?? 0;
    if (presentFlag <= 0) continue;
    const destructibleId = transforms[base] ?? 0;
    const kind = kindById.get(destructibleId);
    if (!kind) continue;

    const center: [number, number, number] = [
      transforms[base + 2] ?? 0,
      transforms[base + 3] ?? 0,
      transforms[base + 4] ?? 0,
    ];
    const aabbHalfExtents = quaternionToWorldAabbHalfExtents(
      CHUNK_HALF_EXTENTS_BY_KIND[kind],
      transforms[base + 5] ?? 0,
      transforms[base + 6] ?? 0,
      transforms[base + 7] ?? 0,
      transforms[base + 8] ?? 1,
    );
    lowestChunkBottomY = Math.min(lowestChunkBottomY, center[1] - aabbHalfExtents[1]);

    const samples = samplesById.get(destructibleId);
    const sample: ChunkMetricsSample = {
      destructibleId,
      chunkIndex: transforms[base + 1] ?? 0,
      center,
      aabbHalfExtents,
    };
    if (samples) {
      samples.push(sample);
    } else {
      samplesById.set(destructibleId, [sample]);
    }
  }

  let overlapPairCount = 0;
  let significantOverlapPairCount = 0;
  let maxOverlapPenetrationM = 0;
  let nearCoincidentPairCount = 0;
  let minCenterDistanceM = Number.POSITIVE_INFINITY;
  const sampleOverlapPairs: DestructibleOverlapSample[] = [];

  for (const samples of samplesById.values()) {
    for (let i = 0; i < samples.length; i += 1) {
      const left = samples[i];
      for (let j = i + 1; j < samples.length; j += 1) {
        const right = samples[j];
        const dx = Math.abs(left.center[0] - right.center[0]);
        const dy = Math.abs(left.center[1] - right.center[1]);
        const dz = Math.abs(left.center[2] - right.center[2]);
        const centerDistance = Math.hypot(dx, dy, dz);
        minCenterDistanceM = Math.min(minCenterDistanceM, centerDistance);
        if (centerDistance < NEAR_COINCIDENT_DISTANCE_EPSILON_M) {
          nearCoincidentPairCount += 1;
        }

        const overlapX = left.aabbHalfExtents[0] + right.aabbHalfExtents[0] - dx;
        const overlapY = left.aabbHalfExtents[1] + right.aabbHalfExtents[1] - dy;
        const overlapZ = left.aabbHalfExtents[2] + right.aabbHalfExtents[2] - dz;
        if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) continue;

        overlapPairCount += 1;
        const penetration = Math.min(overlapX, overlapY, overlapZ);
        maxOverlapPenetrationM = Math.max(maxOverlapPenetrationM, penetration);
        if (penetration > SIGNIFICANT_OVERLAP_EPSILON_M) {
          significantOverlapPairCount += 1;
          if (sampleOverlapPairs.length < 8) {
            sampleOverlapPairs.push({
              destructibleId: left.destructibleId,
              leftChunkIndex: left.chunkIndex,
              rightChunkIndex: right.chunkIndex,
              penetrationM: penetration,
              centerDistanceM: centerDistance,
              leftCenter: [...left.center],
              rightCenter: [...right.center],
            });
          }
        }
      }
    }
  }

  return {
    overlapPairCount,
    significantOverlapPairCount,
    maxOverlapPenetrationM,
    nearCoincidentPairCount,
    minCenterDistanceM: Number.isFinite(minCenterDistanceM) ? minCenterDistanceM : -1,
    lowestChunkBottomY: Number.isFinite(lowestChunkBottomY) ? lowestChunkBottomY : 0,
    sampleOverlapPairs,
  };
}
