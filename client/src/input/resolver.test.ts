import { describe, expect, it } from 'vitest';
import {
  advanceLookAngles,
  advanceVehicleCamera,
  resolveOnFootInput,
  resolveSnapMachineInput,
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
    resetVehiclePressed: false,
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

describe('resolveSnapMachineInput', () => {
  it('forwards live channel values without touching moveX/moveY/buttons', () => {
    const channels = new Int8Array(8);
    channels[0] = 127;
    channels[1] = -64;
    const resolved = resolveSnapMachineInput(
      snapshot({ moveX: 1, moveY: 1, jump: true }),
      1.2,
      -0.4,
      'keyboardMouse',
      channels,
    );
    expect(resolved.moveX).toBe(0);
    expect(resolved.moveY).toBe(0);
    expect(resolved.buttons).toBe(0);
    expect(resolved.machineChannels).toBeDefined();
    expect(Array.from(resolved.machineChannels!)).toEqual([127, -64, 0, 0, 0, 0, 0, 0]);
    // The resolver must copy the buffer, so mutating the caller's
    // array afterwards does NOT alter the resolved input.
    channels[0] = 0;
    expect(resolved.machineChannels![0]).toBe(127);
  });

  it('fires interactPressed when the ActionSnapshot says so', () => {
    // `KeyboardMouseInputSource.sample` is responsible for routing
    // `interactPressed` through the dedicated `machineExit` key while
    // in snap-machine context — the resolver just trusts the bit.
    const resolved = resolveSnapMachineInput(
      snapshot({ interactPressed: true }),
      0,
      0,
      'keyboardMouse',
      new Int8Array(8),
    );
    expect(resolved.interactPressed).toBe(true);
  });
});
