import { describe, it, expect } from 'vitest';
import { buildInputFromButtons } from './inputBuilder';
import {
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_CROUCH,
  BTN_SECONDARY_FIRE,
  BTN_RELOAD,
} from '../net/protocol';

describe('buildInputFromButtons', () => {
  it('returns zero moveX/moveY when no directional buttons pressed', () => {
    const cmd = buildInputFromButtons(1, 0, 0, 0, 0);
    expect(cmd.moveX).toBe(0);
    expect(cmd.moveY).toBe(0);
    expect(cmd.buttons).toBe(0);
  });

  it('forward sets moveY to +127', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_FORWARD, 0, 0);
    expect(cmd.moveY).toBe(127);
    expect(cmd.moveX).toBe(0);
  });

  it('back sets moveY to -127', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_BACK, 0, 0);
    expect(cmd.moveY).toBe(-127);
    expect(cmd.moveX).toBe(0);
  });

  it('right sets moveX to +127', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_RIGHT, 0, 0);
    expect(cmd.moveX).toBe(127);
    expect(cmd.moveY).toBe(0);
  });

  it('left sets moveX to -127', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_LEFT, 0, 0);
    expect(cmd.moveX).toBe(-127);
    expect(cmd.moveY).toBe(0);
  });

  it('forward+right sets both moveX and moveY', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_FORWARD | BTN_RIGHT, 0, 0);
    expect(cmd.moveX).toBe(127);
    expect(cmd.moveY).toBe(127);
  });

  it('forward+back cancel out to moveY=0', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_FORWARD | BTN_BACK, 0, 0);
    expect(cmd.moveY).toBe(0);
  });

  it('left+right cancel out to moveX=0', () => {
    const cmd = buildInputFromButtons(1, 0, BTN_LEFT | BTN_RIGHT, 0, 0);
    expect(cmd.moveX).toBe(0);
  });

  it('preserves seq number', () => {
    const cmd = buildInputFromButtons(42, 0, 0, 0, 0);
    expect(cmd.seq).toBe(42);
  });

  it('quantizes yaw and pitch to match network encoding', () => {
    const cmd = buildInputFromButtons(1, 0, 0, 1.5, -0.3);
    expect(cmd.yaw).toBeCloseTo(1.5, 2);
    expect(cmd.pitch).toBeCloseTo(-0.3 + Math.PI * 2, 2); // wraps to [0, 2π)
  });

  it('preserves action buttons (jump, sprint, crouch)', () => {
    const buttons = BTN_FORWARD | BTN_JUMP | BTN_SPRINT | BTN_CROUCH;
    const cmd = buildInputFromButtons(1, 0, buttons, 0, 0);
    expect(cmd.buttons & BTN_JUMP).toBeTruthy();
    expect(cmd.buttons & BTN_SPRINT).toBeTruthy();
    expect(cmd.buttons & BTN_CROUCH).toBeTruthy();
    expect(cmd.buttons & BTN_FORWARD).toBeTruthy();
  });

  it('strips BTN_SECONDARY_FIRE and BTN_RELOAD from output', () => {
    const buttons = BTN_FORWARD | BTN_SECONDARY_FIRE | BTN_RELOAD;
    const cmd = buildInputFromButtons(1, 0, buttons, 0, 0);
    expect(cmd.buttons & BTN_SECONDARY_FIRE).toBe(0);
    expect(cmd.buttons & BTN_RELOAD).toBe(0);
    expect(cmd.buttons & BTN_FORWARD).toBeTruthy();
  });

  it('all four directions at once cancel to zero movement', () => {
    const buttons = BTN_FORWARD | BTN_BACK | BTN_LEFT | BTN_RIGHT;
    const cmd = buildInputFromButtons(1, 0, buttons, 0, 0);
    expect(cmd.moveX).toBe(0);
    expect(cmd.moveY).toBe(0);
  });
});
