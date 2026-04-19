import { describe, expect, it } from 'vitest';
import { pickActiveFamily, resolveActiveFamily } from './arbiter';
import type { ActionSnapshot } from './types';

function snapshot(overrides: Partial<ActionSnapshot>): ActionSnapshot {
  return {
    family: 'keyboardMouse',
    activityId: 0,
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
    aimSecondary: false,
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

describe('pickActiveFamily', () => {
  it('prefers the only meaningful family', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 1 });
    expect(pickActiveFamily(null, keyboardMouse, null)).toBe('keyboardMouse');
  });

  it('treats aimSecondary as meaningful input', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', aimSecondary: true, activityId: 1 });
    expect(pickActiveFamily(null, keyboardMouse, null)).toBe('keyboardMouse');
  });

  it('keeps current family when the other family has no newer activity', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 4 });
    const gamepad = snapshot({ family: 'gamepad', moveX: 1, activityId: 3 });
    expect(pickActiveFamily('keyboardMouse', keyboardMouse, gamepad)).toBe('keyboardMouse');
  });

  it('switches to the other family when it has newer meaningful activity', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 4 });
    const gamepad = snapshot({ family: 'gamepad', moveX: 1, activityId: 5 });
    expect(pickActiveFamily('keyboardMouse', keyboardMouse, gamepad)).toBe('gamepad');
  });

  it('picks touch when it is the only meaningful family', () => {
    const touch = snapshot({ family: 'touch', moveX: 0.6, activityId: 2 });
    expect(pickActiveFamily(null, null, null, touch)).toBe('touch');
  });

  it('prefers touch over keyboard when touch has newer activity', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 3 });
    const touch = snapshot({ family: 'touch', moveX: 1, activityId: 9 });
    expect(pickActiveFamily('keyboardMouse', keyboardMouse, null, touch)).toBe('touch');
  });

  it('keeps touch sticky when no family has strictly newer activity', () => {
    const touch = snapshot({ family: 'touch', moveX: 0.5, activityId: 10 });
    const gamepad = snapshot({ family: 'gamepad', moveX: 0.2, activityId: 8 });
    expect(pickActiveFamily('touch', null, gamepad, touch)).toBe('touch');
  });
});

describe('resolveActiveFamily', () => {
  it('uses explicit keyboardMouse mode even when gamepad is active', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', activityId: 1 });
    const gamepad = snapshot({ family: 'gamepad', moveX: 1, activityId: 5 });
    expect(resolveActiveFamily('keyboardMouse', null, keyboardMouse, gamepad)).toBe('keyboardMouse');
  });

  it('uses explicit gamepad mode even when keyboard is active', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 5 });
    const gamepad = snapshot({ family: 'gamepad', activityId: 1 });
    expect(resolveActiveFamily('gamepad', null, keyboardMouse, gamepad)).toBe('gamepad');
  });

  it('falls back to auto arbitration in auto mode', () => {
    const keyboardMouse = snapshot({ family: 'keyboardMouse', moveY: 1, activityId: 2 });
    const gamepad = snapshot({ family: 'gamepad', moveX: 1, activityId: 3 });
    expect(resolveActiveFamily('auto', null, keyboardMouse, gamepad)).toBe('gamepad');
  });
});
