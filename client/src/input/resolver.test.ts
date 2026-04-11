import { describe, expect, it } from 'vitest';
import {
  advanceLookAngles,
  advanceVehicleCamera,
  resolveOnFootInput,
  resolveVehicleInput,
  VEHICLE_CAMERA_DEFAULT_PITCH,
} from './resolver';
import { BTN_JUMP, BTN_SPRINT } from '../net/protocol';
import type { ActionSnapshot } from './types';

function snapshot(overrides: Partial<ActionSnapshot>): ActionSnapshot {
  return {
    family: 'gamepad',
    activityId: 1,
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    jump: false,
    sprint: false,
    crouch: false,
    firePrimary: false,
    firePrimaryValue: 0,
    handbrake: false,
    interactPressed: false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
    ...overrides,
  };
}

describe('advanceLookAngles', () => {
  it('applies look deltas to yaw and pitch', () => {
    const next = advanceLookAngles(1, 0.5, snapshot({ lookX: 0.25, lookY: -0.2 }));
    expect(next.yaw).toBeCloseTo(1.25);
    expect(next.pitch).toBeCloseTo(0.3);
  });
});

describe('advanceVehicleCamera', () => {
  it('recenters toward the default orbit when idle', () => {
    const next = advanceVehicleCamera(1, -0.2, null, 500, 0.5);
    expect(next.orbitYaw).toBeLessThan(1);
    expect(next.orbitPitch).toBeGreaterThan(-0.2);
    expect(next.orbitPitch).toBeLessThanOrEqual(VEHICLE_CAMERA_DEFAULT_PITCH);
  });
});

describe('resolveOnFootInput', () => {
  it('maps action buttons into protocol buttons', () => {
    const resolved = resolveOnFootInput(snapshot({ moveX: 0.5, moveY: 1, jump: true, sprint: true }), 1.2, -0.4, 'keyboardMouse');
    expect(resolved.moveX).toBeCloseTo(0.5);
    expect(resolved.moveY).toBe(1);
    expect(resolved.buttons & BTN_JUMP).toBeTruthy();
    expect(resolved.buttons & BTN_SPRINT).toBeTruthy();
  });
});

describe('resolveVehicleInput', () => {
  it('maps steer/throttle/brake into signed movement axes', () => {
    const resolved = resolveVehicleInput(snapshot({ steer: -0.75, throttle: 1, brake: 0.25, handbrake: true }), 0, 0, 'gamepad');
    expect(resolved.moveX).toBeCloseTo(-0.75);
    expect(resolved.moveY).toBeCloseTo(0.75);
    expect(resolved.buttons & BTN_JUMP).toBeTruthy();
  });
});
