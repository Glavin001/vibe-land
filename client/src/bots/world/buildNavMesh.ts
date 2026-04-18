/**
 * Wraps navcat navmesh generation using shared player-navigation limits.
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
import {
  getSharedPlayerNavigationProfileAsync,
  type SharedPlayerNavigationProfile,
} from '../../wasm/sharedPhysics';
import { buildWorldGeometry, type BotWorldGeometry } from './worldGeometry';

export type NavMeshMode = 'solo' | 'tiled';

export interface BuildBotNavMeshOptions {
  navigationProfile: SharedPlayerNavigationProfile;
  mode?: NavMeshMode;
  cellSize?: number;
  cellHeight?: number;
  tileSizeVoxels?: number;
}

export interface BuildBotNavMeshFromSharedProfileOptions {
  mode?: NavMeshMode;
  cellSize?: number;
  cellHeight?: number;
  tileSizeVoxels?: number;
}

export interface BotNavMesh {
  navMesh: NavMesh;
  geometry: BotWorldGeometry;
  navigationProfile: SharedPlayerNavigationProfile;
  mode: NavMeshMode;
  result: SoloNavMeshResult | TiledNavMeshResult;
  buildConfig: ResolvedBotNavMeshConfig;
}

export interface ResolvedBotNavMeshConfig {
  navigationProfile: SharedPlayerNavigationProfile;
  mode: NavMeshMode;
  cellSize: number;
  cellHeight: number;
  tileSizeVoxels: number;
}

const DEFAULTS = Object.freeze({
  mode: 'tiled' as NavMeshMode,
  cellSize: 0.25,
  cellHeight: 0.1,
  tileSizeVoxels: 64,
});

function defaultCellHeightForNavigationProfile(navigationProfile: SharedPlayerNavigationProfile): number {
  const climb = navigationProfile.walkableClimb;
  if (!(climb > 0)) return DEFAULTS.cellHeight;
  // Represent the shared KCC climb limit with enough vertical precision that
  // 0.55 m stays walkable without rounding the navmesh up to 0.6 m.
  return Math.min(DEFAULTS.cellHeight, climb / 20);
}

export function buildBotNavMesh(world: WorldDocument, options: BuildBotNavMeshOptions): BotNavMesh {
  const buildConfig = resolveBotNavMeshConfig(options);
  const {
    mode,
    cellSize,
    cellHeight,
    navigationProfile,
    tileSizeVoxels,
  } = buildConfig;
  const walkableRadiusWorld = navigationProfile.walkableRadius;
  const walkableHeightWorld = navigationProfile.walkableHeight;
  const walkableClimbWorld = navigationProfile.walkableClimb;
  const walkableSlopeAngleDegrees = navigationProfile.walkableSlopeAngleDegrees;

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
    return { navMesh: result.navMesh, geometry, navigationProfile, mode, result, buildConfig };
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
  return { navMesh: result.navMesh, geometry, navigationProfile, mode, result, buildConfig };
}

export function resolveBotNavMeshConfig(
  options: BuildBotNavMeshOptions,
): ResolvedBotNavMeshConfig {
  const navigationProfile = options.navigationProfile;
  const resolved = {
    navigationProfile,
    mode: options.mode ?? DEFAULTS.mode,
    cellSize: options.cellSize ?? DEFAULTS.cellSize,
    cellHeight: options.cellHeight ?? defaultCellHeightForNavigationProfile(navigationProfile),
    tileSizeVoxels: options.tileSizeVoxels ?? DEFAULTS.tileSizeVoxels,
  };
  return resolved;
}

export async function buildBotNavMeshFromSharedProfile(
  world: WorldDocument,
  options: BuildBotNavMeshFromSharedProfileOptions = {},
): Promise<BotNavMesh> {
  const navigationProfile = await getSharedPlayerNavigationProfileAsync();
  return buildBotNavMesh(world, {
    ...options,
    navigationProfile,
  });
}
