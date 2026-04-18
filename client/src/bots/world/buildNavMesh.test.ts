import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_QUERY_FILTER, FindPathResultFlags, findPath } from 'navcat';

import {
  getSharedPlayerNavigationProfile,
  hydrateSharedPlayerNavigationProfileFromLoadedWasm,
} from '../../wasm/sharedPhysics';
import { initWasmForTests } from '../../wasm/testInit';
import { identityQuaternion, type WorldDocument } from '../../world/worldDocument';
import { buildBotNavMesh } from './buildNavMesh';

beforeAll(() => {
  initWasmForTests();
  hydrateSharedPlayerNavigationProfileFromLoadedWasm();
});

function makeStepWorld(stepHeight: number): WorldDocument {
  return {
    version: 2,
    meta: {
      name: `Step ${stepHeight.toFixed(2)}m`,
      description: 'Two floor slabs sharing an edge.',
    },
    terrain: {
      tileGridSize: 2,
      tileHalfExtentM: 1,
      tiles: [],
    },
    staticProps: [
      {
        id: 1,
        kind: 'cuboid',
        position: [-1.5, -0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [1.5, 0.25, 2],
      },
      {
        id: 2,
        kind: 'cuboid',
        position: [1.5, stepHeight - 0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [1.5, 0.25, 2],
      },
    ],
    dynamicEntities: [],
  };
}

function makeSlopeWorld(riseAcrossTile: number): WorldDocument {
  const heights = [
    0, riseAcrossTile * 0.5, riseAcrossTile,
    0, riseAcrossTile * 0.5, riseAcrossTile,
    0, riseAcrossTile * 0.5, riseAcrossTile,
  ];
  return {
    version: 2,
    meta: {
      name: `Slope ${riseAcrossTile.toFixed(2)}m`,
      description: 'A single terrain tile with a constant slope along X.',
    },
    terrain: {
      tileGridSize: 3,
      tileHalfExtentM: 1,
      tiles: [{
        tileX: 0,
        tileZ: 0,
        heights,
      }],
    },
    staticProps: [],
    dynamicEntities: [],
  };
}

function hasFlag(flags: number, flag: FindPathResultFlags): boolean {
  return (flags & flag) !== 0;
}

function canReachAcrossWorld(world: WorldDocument, start: [number, number, number], end: [number, number, number]): boolean {
  const nav = buildBotNavMesh(world, {
    navigationProfile: getSharedPlayerNavigationProfile(),
    mode: 'solo',
  });
  const result = findPath(
    nav.navMesh,
    start,
    end,
    [0.75, 1.5, 0.75],
    DEFAULT_QUERY_FILTER,
  );
  return result.success && hasFlag(result.flags, FindPathResultFlags.COMPLETE_PATH);
}

describe('buildBotNavMesh', () => {
  it('connects a 0.5m step using the shared KCC climb limit', () => {
    expect(canReachAcrossWorld(
      makeStepWorld(0.5),
      [-1, 0.3, 0],
      [1, 0.8, 0],
    )).toBe(true);
  });

  it('does not connect a 0.6m step above the shared KCC climb limit', () => {
    expect(canReachAcrossWorld(
      makeStepWorld(0.6),
      [-1, 0.3, 0],
      [1, 0.9, 0],
    )).toBe(false);
  });

  it('does not treat slopes above 45 degrees as walkable by default', () => {
    expect(canReachAcrossWorld(
      makeSlopeWorld(2.2),
      [-0.75, 0.2, 0],
      [0.75, 2.4, 0],
    )).toBe(false);
  });
});
