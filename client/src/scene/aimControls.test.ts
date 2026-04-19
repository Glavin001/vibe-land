import { describe, expect, it } from 'vitest';
import { canUseScopedAim } from './aimControls';

describe('canUseScopedAim', () => {
  it('allows mouse aim only when pointer lock is active', () => {
    expect(canUseScopedAim('keyboardMouse', true, false)).toBe(true);
    expect(canUseScopedAim('keyboardMouse', false, false)).toBe(false);
  });

  it('allows gamepad scoped aim without pointer lock', () => {
    expect(canUseScopedAim('gamepad', false, false)).toBe(true);
  });

  it('allows touch scoped aim without pointer lock', () => {
    expect(canUseScopedAim('touch', false, false)).toBe(true);
  });

  it('blocks scoped aim while dead', () => {
    expect(canUseScopedAim('gamepad', false, true)).toBe(false);
  });

  it('allows benchmark autopilot regardless of pointer lock', () => {
    expect(canUseScopedAim('keyboardMouse', false, false, true)).toBe(true);
  });
});
