import { beforeAll, describe, expect, it } from 'vitest';

import {
  getSharedPlayerNavigationProfile,
  hydrateSharedPlayerNavigationProfileFromLoadedWasm,
} from '../../wasm/sharedPhysics';
import { initWasmForTests } from '../../wasm/testInit';
import { identityQuaternion, type WorldDocument } from '../../world/worldDocument';
import { createBotCrowd } from './BotCrowd';

beforeAll(() => {
  initWasmForTests();
  hydrateSharedPlayerNavigationProfileFromLoadedWasm();
});

function makeGapWorld(): WorldDocument {
  return {
    version: 2,
    meta: {
      name: 'Gap World',
      description: 'Two disconnected flat platforms at the same height.',
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
        position: [-3, -0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [2, 0.25, 2],
      },
      {
        id: 2,
        kind: 'cuboid',
        position: [3, -0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [2, 0.25, 2],
      },
    ],
    dynamicEntities: [],
  };
}

function makeCliffWorld(stepHeight: number): WorldDocument {
  return {
    version: 2,
    meta: {
      name: `Cliff ${stepHeight.toFixed(2)}m`,
      description: 'Two slabs sharing an edge with an unclimbable height difference.',
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
        position: [-2, -0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [2, 0.25, 3],
      },
      {
        id: 2,
        kind: 'cuboid',
        position: [2, stepHeight - 0.25, 0],
        rotation: identityQuaternion(),
        halfExtents: [2, 0.25, 3],
      },
    ],
    dynamicEntities: [],
  };
}

describe('BotCrowd', () => {
  it('repairs the corridor when authoritative bot sync teleports to a different platform', () => {
    const crowd = createBotCrowd(makeGapWorld(), {
      navigationProfile: getSharedPlayerNavigationProfile(),
      mode: 'solo',
    });

    const handle = crowd.addBot([-3, 0, 0]);
    const agent = crowd.getAgent(handle.id);
    expect(agent).toBeTruthy();

    const rightGround = crowd.findNearestWalkable([3, 0, 0]);
    expect(rightGround).toBeTruthy();
    const authoritativeCenter: [number, number, number] = [
      3,
      (rightGround?.position[1] ?? 0) + getSharedPlayerNavigationProfile().walkableHeight * 0.5,
      0,
    ];

    crowd.syncBotPosition(handle, authoritativeCenter);

    expect(agent?.position[0]).toBeCloseTo(rightGround?.position[0] ?? 0, 5);
    expect(agent?.position[2]).toBeCloseTo(rightGround?.position[2] ?? 0, 5);
    expect(agent?.corridor.position[0]).toBeCloseTo(rightGround?.position[0] ?? 0, 5);
    expect(agent?.corridor.position[2]).toBeCloseTo(rightGround?.position[2] ?? 0, 5);
    expect(agent?.corridor.path[0]).toBe(rightGround?.nodeRef);
  });

  it('snaps player-center chase targets to the reachable floor below an unclimbable ledge', () => {
    const profile = getSharedPlayerNavigationProfile();
    const crowd = createBotCrowd(makeCliffWorld(0.6), {
      navigationProfile: profile,
      mode: 'solo',
    });

    const handle = crowd.addBot([-1, 0, 0]);
    const lowerGround = crowd.findNearestWalkable([-1, 0, 0]);
    expect(lowerGround).toBeTruthy();

    const playerCenterNearLedge: [number, number, number] = [
      -0.1,
      (lowerGround?.position[1] ?? 0) + profile.walkableHeight * 0.5,
      0,
    ];

    expect(crowd.requestMoveTo(handle, playerCenterNearLedge)).toBe(true);
    expect(handle.targetPosition).not.toBeNull();
    expect(handle.targetPosition?.[0] ?? 1).toBeLessThan(0);
    expect(handle.targetPosition?.[1] ?? 1).toBeLessThan(0.2);
  });
});
