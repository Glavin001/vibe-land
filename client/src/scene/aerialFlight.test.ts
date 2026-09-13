import { describe, expect, it } from 'vitest';
import type { ActionSnapshot } from '../input/types';
import { advanceAerialPose, type AerialPose } from './aerialFlight';

const origin: AerialPose = { position: [0, 0, 0], yaw: 0, pitch: 0 };
function action(overrides: Partial<ActionSnapshot>): ActionSnapshot {
  return {
    family: 'keyboardMouse', activityId: 1, moveX: 0, moveY: 0,
    lookX: 0, lookY: 0, steer: 0, throttle: 0, brake: 0,
    jump: false, sprint: false, crouch: false, firePrimary: false,
    firePrimaryValue: 0, aimSecondary: false, handbrake: false,
    interactPressed: false, resetVehiclePressed: false,
    blockRemovePressed: false, blockPlacePressed: false,
    materialSlot1Pressed: false, materialSlot2Pressed: false,
    meleePressed: false, ...overrides,
  };
}

describe('aerial camera movement', () => {
  it('moves forward and right in the same coordinates as the player camera', () => {
    expect(advanceAerialPose(origin, action({ moveY: 1 }), 30, 0.1).position).toEqual([0, 0, 3]);
    expect(advanceAerialPose(origin, action({ moveX: 1 }), 30, 0.1).position).toEqual([-3, 0, 0]);
    const turned = advanceAerialPose({ ...origin, yaw: Math.PI / 2 }, action({ moveY: 1 }), 30, 0.1);
    expect(turned.position[0]).toBeCloseTo(3);
    expect(turned.position[2]).toBeCloseTo(0);
  });

  it('rises and descends vertically regardless of the viewing angle', () => {
    const tilted = { ...origin, pitch: 0.8, yaw: 1.3 };
    expect(advanceAerialPose(tilted, action({ jump: true }), 30, 0.1).position).toEqual([0, 3, 0]);
    expect(advanceAerialPose(tilted, action({ crouch: true }), 30, 0.1).position).toEqual([0, -3, 0]);
  });

  it('flies in the viewing direction and caps combined movement speed', () => {
    const tilted = advanceAerialPose({ ...origin, pitch: Math.PI / 4 }, action({ moveY: 1 }), 30, 0.1);
    expect(tilted.position[1]).toBeCloseTo(3 / Math.sqrt(2));
    expect(tilted.position[2]).toBeCloseTo(3 / Math.sqrt(2));
    const diagonal = advanceAerialPose(origin, action({ moveY: 1, moveX: 1, jump: true }), 30, 0.1);
    expect(Math.hypot(...diagonal.position)).toBeCloseTo(3);
  });

  it('supports analog input, chosen speed, and a threefold sprint boost', () => {
    expect(advanceAerialPose(origin, action({ moveY: 0.5 }), 40, 0.1).position[2]).toBe(2);
    expect(advanceAerialPose(origin, action({ moveY: 1, sprint: true }), 40, 0.1).position[2]).toBe(12);
  });

  it('is independent of frame rate and prevents a large jump after a stall', () => {
    const moving = action({ moveY: 1 });
    let pose = origin;
    for (let i = 0; i < 6; i++) pose = advanceAerialPose(pose, moving, 30, 1 / 60);
    expect(pose.position).toEqual(advanceAerialPose(origin, moving, 30, 0.1).position);
    expect(advanceAerialPose(origin, moving, 30, 5).position).toEqual([0, 0, 3]);
  });

  it('holds position without input and does not mutate the supplied pose or action', () => {
    expect(advanceAerialPose(origin, null, 30, 0.1)).toEqual(origin);
    const input = action({ moveY: 1, firePrimary: true });
    const before = structuredClone(input);
    advanceAerialPose(origin, input, 30, 0.1);
    expect(input).toEqual(before);
    expect(origin.position).toEqual([0, 0, 0]);
  });

  it('keeps mouse look away from a singular straight-up camera orientation', () => {
    const pose = advanceAerialPose(origin, action({ lookX: 0.5, lookY: 100 }), 30, 0.1);
    expect(pose.yaw).toBe(0.5);
    expect(pose.pitch).toBeLessThan(Math.PI / 2);
    expect(pose.pitch).toBeGreaterThan(1.5);
  });
});
