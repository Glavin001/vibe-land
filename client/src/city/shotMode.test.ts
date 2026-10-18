import { describe, expect, it } from 'vitest';

import { applyWeaponInput, cycleShotMode, setShotMode, shotMode, SHOT_MODES } from './shotMode';

describe('weapon switching', () => {
  it('steps through every weapon both ways, wrapping', () => {
    expect(cycleShotMode('rifle', 1)).toBe('cannonball');
    expect(cycleShotMode('meteor', 1)).toBe('rifle');
    expect(cycleShotMode('rifle', -1)).toBe('meteor');
    let mode = SHOT_MODES[0];
    for (let i = 0; i < SHOT_MODES.length; i += 1) mode = cycleShotMode(mode, 1);
    expect(mode).toBe(SHOT_MODES[0]);
  });

  it('picks a weapon by slot (1 rifle, 2 cannon, 3 meteor), and a slot wins over a step', () => {
    setShotMode('rifle');
    applyWeaponInput(3, 0);
    expect(shotMode()).toBe('meteor');
    applyWeaponInput(1, 1);
    expect(shotMode()).toBe('rifle');
    applyWeaponInput(0, 1);
    expect(shotMode()).toBe('cannonball');
    applyWeaponInput(0, -1);
    expect(shotMode()).toBe('rifle');
    applyWeaponInput(9, 0);
    expect(shotMode()).toBe('rifle');
  });
});
