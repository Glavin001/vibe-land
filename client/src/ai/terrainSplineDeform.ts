import type { SplineData } from './splineData';
import {
  buildArcLengthTable,
  computeSplineBounds,
  projectPointOntoSpline,
} from './splineMath';
import {
  TERRAIN_MIN_HEIGHT,
  TERRAIN_MAX_HEIGHT,
  getTerrainTileBounds,
  getTerrainTileWorldPosition,
  type WorldDocument,
} from '../world/worldDocument';

export type ProfilePoint = { u: number; y: number };

export type DeformTerrainAlongSplineOptions = {
  spline: SplineData;
  profile: ProfilePoint[];
  mode: 'absolute' | 'relative';
  applyMode: 'blend' | 'raiseOnly' | 'lowerOnly';
  strength: number;
  falloff: number;
  sampleSpacing?: number;
};

function interpolateProfile(
  profile: ProfilePoint[],
  across: number,
  falloff: number,
): { y: number; influence: number } | null {
  const sorted = profile.length > 1 && profile[0].u <= profile[profile.length - 1].u
    ? profile
    : [...profile].sort((a, b) => a.u - b.u);

  const minU = sorted[0].u;
  const maxU = sorted[sorted.length - 1].u;

  if (across >= minU && across <= maxU) {
    // Within profile extent — find bracketing points and interpolate
    for (let i = 0; i < sorted.length - 1; i++) {
      if (across >= sorted[i].u && across <= sorted[i + 1].u) {
        const span = sorted[i + 1].u - sorted[i].u;
        const t = span > 1e-9 ? (across - sorted[i].u) / span : 0;
        return { y: sorted[i].y + t * (sorted[i + 1].y - sorted[i].y), influence: 1 };
      }
    }
    return { y: sorted[sorted.length - 1].y, influence: 1 };
  }

  // Beyond profile extent — apply falloff
  if (falloff <= 0) return null;

  let beyond: number;
  let edgeY: number;
  if (across < minU) {
    beyond = minU - across;
    edgeY = sorted[0].y;
  } else {
    beyond = across - maxU;
    edgeY = sorted[sorted.length - 1].y;
  }

  if (beyond > falloff) return null;
  const t = 1 - beyond / falloff;
  return { y: edgeY, influence: t * t };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function aabbOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function deformTerrainAlongSpline(
  world: WorldDocument,
  options: DeformTerrainAlongSplineOptions,
): WorldDocument {
  const { spline, profile, mode, applyMode, falloff } = options;
  const strength = clamp(options.strength, 0, 1);

  if (profile.length < 2 || spline.points.length < 2) return world;

  const arcTable = buildArcLengthTable(spline);
  const totalLength = arcTable.length > 0 ? arcTable[arcTable.length - 1].distance : 0;
  if (totalLength <= 0) return world;

  // Compute max profile extent for bounding
  let maxProfileU = 0;
  for (const p of profile) {
    const absU = Math.abs(p.u);
    if (absU > maxProfileU) maxProfileU = absU;
  }
  const totalExtent = maxProfileU + falloff;

  // Expanded spline bounds for filtering tiles
  const sBounds = computeSplineBounds(spline);
  const expandedBounds = {
    minX: sBounds.minX - totalExtent,
    maxX: sBounds.maxX + totalExtent,
    minZ: sBounds.minZ - totalExtent,
    maxZ: sBounds.maxZ + totalExtent,
  };

  const next: WorldDocument = {
    ...world,
    terrain: { ...world.terrain, tiles: [...world.terrain.tiles] },
  };
  let mutated = false;

  for (let tileIndex = 0; tileIndex < world.terrain.tiles.length; tileIndex++) {
    const sourceTile = world.terrain.tiles[tileIndex];
    const tileBounds = getTerrainTileBounds(world, sourceTile.tileX, sourceTile.tileZ);
    if (!aabbOverlap(tileBounds, expandedBounds)) continue;

    let nextTile = next.terrain.tiles[tileIndex];

    for (let row = 0; row < world.terrain.tileGridSize; row++) {
      for (let col = 0; col < world.terrain.tileGridSize; col++) {
        const [wx, wz] = getTerrainTileWorldPosition(world, sourceTile, row, col);

        // Quick bounding check
        if (wx < expandedBounds.minX || wx > expandedBounds.maxX
          || wz < expandedBounds.minZ || wz > expandedBounds.maxZ) {
          continue;
        }

        const proj = projectPointOntoSpline(spline, { x: wx, z: wz }, arcTable);

        // For open splines, skip points beyond the spline ends
        if (!spline.closed && (proj.along < 0 || proj.along > totalLength)) {
          continue;
        }

        const profileResult = interpolateProfile(profile, proj.across, falloff);
        if (!profileResult) continue;

        const idx = row * world.terrain.tileGridSize + col;
        const currentHeight = sourceTile.heights[idx] ?? 0;

        // Compute target height
        let target: number;
        if (mode === 'absolute') {
          target = profileResult.y;
        } else {
          target = currentHeight + profileResult.y;
        }

        // Apply mode filter
        if (applyMode === 'raiseOnly' && target <= currentHeight) continue;
        if (applyMode === 'lowerOnly' && target >= currentHeight) continue;

        // Blend
        const delta = strength * profileResult.influence * (target - currentHeight);
        const newHeight = clamp(currentHeight + delta, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);

        if (Math.abs(newHeight - currentHeight) < 1e-6) continue;

        // Copy-on-write
        if (nextTile === sourceTile) {
          nextTile = { ...sourceTile, heights: [...sourceTile.heights] };
          next.terrain.tiles[tileIndex] = nextTile;
        }
        nextTile.heights[idx] = newHeight;
        mutated = true;
      }
    }
  }

  return mutated ? next : world;
}
