/**
 * Wraps navcat's {@link generateSoloNavMesh} / {@link generateTiledNavMesh}
 * with KCC-matched defaults so callers can go from a {@link WorldDocument} to
 * a query-ready {@link NavMesh} in one line.
 *
 * The option defaults intentionally mirror the Rapier kinematic character
 * controller parameters declared in `shared/src/movement.rs`:
 * - capsule radius 0.35m
 * - capsule height ~1.6m
 * - step height 0.55m
 * - walkable slope ~55°
 *
 * Keeping these in sync means the navmesh only exposes polygons the KCC can
 * actually walk on.
 */

import {
  generateSoloNavMesh,
  generateTiledNavMesh,
  type SoloNavMeshOptions,
  type SoloNavMeshResult,
  type TiledNavMeshOptions,
  type TiledNavMeshResult,
} from 'navcat/blocks';
import type { NavMesh } from 'navcat';

import type { WorldDocument } from '../../world/worldDocument';
import type { VehicleProfile } from '../types';
import { buildWorldGeometry, type BotWorldGeometry } from './worldGeometry';

export type NavMeshMode = 'solo' | 'tiled';

export interface BuildBotNavMeshOptions {
  /** Defaults to `'tiled'` — large terrain worlds benefit from tiling. */
  mode?: NavMeshMode;
  /**
   * Voxel cell size on the horizontal plane (meters).
   * Smaller = more accurate geometry, larger = faster build.
   */
  cellSize?: number;
  /** Voxel cell size vertically (meters). */
  cellHeight?: number;
  /** Agent collision radius (meters). */
  walkableRadius?: number;
  /** Agent height (meters). */
  walkableHeight?: number;
  /** Max step height the agent can climb (meters). */
  walkableClimb?: number;
  /** Max walkable slope angle (degrees). */
  walkableSlopeAngleDegrees?: number;
  /**
   * Tile size in voxels (tiled mode only). Default of 64 ≈ 16m per tile at
   * the default 0.25m cell size, which comfortably fits inside the 160m
   * square world terrain tiles used by vibe-land worlds.
   */
  tileSizeVoxels?: number;
}

export interface BotNavMesh {
  /** The underlying navcat mesh — pass this to crowd / path APIs. */
  navMesh: NavMesh;
  /** The triangle soup the mesh was built from. */
  geometry: BotWorldGeometry;
  /** Build mode that was actually used. */
  mode: NavMeshMode;
  /**
   * Raw navcat build result (kept so callers that want to grab debug
   * intermediates or rebuild tiles can get at them). Either a solo or tiled
   * result — check `mode` to disambiguate.
   */
  result: SoloNavMeshResult | TiledNavMeshResult;
}

const DEFAULTS = Object.freeze({
  mode: 'tiled' as NavMeshMode,
  cellSize: 0.25,
  cellHeight: 0.1,
  walkableRadius: 0.4,
  walkableHeight: 1.7,
  walkableClimb: 0.55,
  walkableSlopeAngleDegrees: 55,
  tileSizeVoxels: 64,
});

/**
 * Builds a navmesh for the given world document.
 *
 * @param world The world to build for. Typically this is the same document
 *   the server loaded — see `shared/src/world_document.rs:9`
 *   (`trail.world.json` is the default).
 * @param options KCC-matched overrides. Defaults track
 *   `shared/src/movement.rs`.
 */
export function buildBotNavMesh(world: WorldDocument, options: BuildBotNavMeshOptions = {}): BotNavMesh {
  const mode: NavMeshMode = options.mode ?? DEFAULTS.mode;
  const cellSize = options.cellSize ?? DEFAULTS.cellSize;
  const cellHeight = options.cellHeight ?? DEFAULTS.cellHeight;
  const walkableRadiusWorld = options.walkableRadius ?? DEFAULTS.walkableRadius;
  const walkableHeightWorld = options.walkableHeight ?? DEFAULTS.walkableHeight;
  const walkableClimbWorld = options.walkableClimb ?? DEFAULTS.walkableClimb;
  const walkableSlopeAngleDegrees =
    options.walkableSlopeAngleDegrees ?? DEFAULTS.walkableSlopeAngleDegrees;
  const tileSizeVoxels = options.tileSizeVoxels ?? DEFAULTS.tileSizeVoxels;

  const geometry = buildWorldGeometry(world);
  const navMeshInput = {
    positions: geometry.positions,
    indices: geometry.indices,
  };

  const walkableRadiusVoxels = Math.max(1, Math.ceil(walkableRadiusWorld / cellSize));
  const walkableClimbVoxels = Math.max(1, Math.ceil(walkableClimbWorld / cellHeight));
  const walkableHeightVoxels = Math.max(1, Math.ceil(walkableHeightWorld / cellHeight));

  const borderSize = walkableRadiusVoxels + 3;
  const minRegionArea = 8;
  const mergeRegionArea = 20;
  const maxSimplificationError = 1.3;
  const maxEdgeLength = 12;
  const maxVerticesPerPoly = 5;
  const detailSampleDistance = cellSize * 6;
  const detailSampleMaxError = cellHeight * 1;

  if (mode === 'solo') {
    const opts: SoloNavMeshOptions = {
      cellSize,
      cellHeight,
      walkableRadiusVoxels,
      walkableRadiusWorld,
      walkableClimbVoxels,
      walkableClimbWorld,
      walkableHeightVoxels,
      walkableHeightWorld,
      walkableSlopeAngleDegrees,
      borderSize,
      minRegionArea,
      mergeRegionArea,
      maxSimplificationError,
      maxEdgeLength,
      maxVerticesPerPoly,
      detailSampleDistance,
      detailSampleMaxError,
    };
    const result = generateSoloNavMesh(navMeshInput, opts);
    return { navMesh: result.navMesh, geometry, mode, result };
  }

  const tileSizeWorld = tileSizeVoxels * cellSize;
  const opts: TiledNavMeshOptions = {
    cellSize,
    cellHeight,
    tileSizeVoxels,
    tileSizeWorld,
    walkableRadiusVoxels,
    walkableRadiusWorld,
    walkableClimbVoxels,
    walkableClimbWorld,
    walkableHeightVoxels,
    walkableHeightWorld,
    walkableSlopeAngleDegrees,
    borderSize,
    minRegionArea,
    mergeRegionArea,
    maxSimplificationError,
    maxEdgeLength,
    maxVerticesPerPoly,
    detailSampleDistance,
    detailSampleMaxError,
  };
  const result = generateTiledNavMesh(navMeshInput, opts);
  return { navMesh: result.navMesh, geometry, mode, result };
}

/**
 * Builds a second, vehicle-sized navmesh for the same world. The walkable
 * radius is inflated to {@link VehicleProfile.agentRadius} so narrow alleys
 * and doorways that a player can squeeze through on foot are automatically
 * excluded — the vehicle simply can't path there.
 *
 * The climb height is dropped to match a car's max step-over (a wheeled
 * chassis can't take 0.55 m curbs) and the slope angle is tightened too so
 * drivable polygons only cover geometry a raycast-vehicle can physically
 * traverse.
 *
 * Callers should not rebuild this mesh every tick — build once per world
 * and reuse it across all vehicle-mode bots.
 */
export function buildVehicleBotNavMesh(
  world: WorldDocument,
  profile: VehicleProfile,
  overrides: BuildBotNavMeshOptions = {},
): BotNavMesh {
  return buildBotNavMesh(world, {
    // Vehicle chassis is fatter than a player capsule — use the profile
    // radius so narrow alleys collapse out of the walkable set.
    walkableRadius: profile.agentRadius,
    walkableHeight: profile.agentHeight,
    // A car can step over maybe ~15 cm; anything more is a cliff from the
    // chassis's perspective.
    walkableClimb: 0.15,
    // Same constraint in rotational form — 25° is already quite steep
    // for a wheeled vehicle.
    walkableSlopeAngleDegrees: 25,
    ...overrides,
  });
}
