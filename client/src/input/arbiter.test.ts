import { describe, expect, it } from 'vitest';
import { pickActiveFamily } from './arbiter';
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
    handbrake: false,
    interactPressed: false,
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
});
