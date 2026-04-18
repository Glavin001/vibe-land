import { beforeAll, describe, expect, it } from 'vitest';
import { initWasmForTests } from './testInit';
import {
  getSharedPlayerNavigationProfile,
  hydrateSharedPlayerNavigationProfileFromLoadedWasm,
} from './sharedPhysics';

beforeAll(() => {
  initWasmForTests();
  hydrateSharedPlayerNavigationProfileFromLoadedWasm();
});

describe('shared player navigation profile', () => {
  it('matches MoveConfig defaults used by navmesh generation', () => {
    const profile = getSharedPlayerNavigationProfile();
    expect(profile.walkableRadius).toBeCloseTo(0.35, 5);
    expect(profile.walkableHeight).toBeCloseTo(1.6, 5);
    expect(profile.walkableClimb).toBeCloseTo(0.55, 5);
    expect(profile.walkableSlopeAngleDegrees).toBeCloseTo(45, 5);
  });
});
