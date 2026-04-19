import { describe, expect, it } from 'vitest';
import { agentStateToIntent, createSteeringState } from './steering';
import { BTN_JUMP } from '../../net/protocol';
import type { BotSelfState, Vec3Tuple } from '../types';

function makeSelf(overrides: Partial<BotSelfState> = {}): BotSelfState {
  return {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: true,
    dead: false,
    ...overrides,
  };
}

describe('agentStateToIntent melee handling', () => {
  it('suppresses BTN_JUMP while meleeAim is set, even when stuck', () => {
    const state = createSteeringState();
    state.stuckTicks = 9999;
    state.jumpCooldownTicks = 0;
    const self = makeSelf();
    const meleeAim: Vec3Tuple = [1.5, 0, 0];
    const intent = agentStateToIntent(undefined, self, state, 'follow_target', 7, null, meleeAim);
    expect(intent.buttons & BTN_JUMP).toBe(0);
    expect(intent.meleePrimary).toBe(true);
    expect(intent.firePrimary).toBe(false);
    expect(state.stuckTicks).toBe(0);
  });

  it('orients yaw toward the melee target', () => {
    const state = createSteeringState();
    const self = makeSelf();
    const meleeAim: Vec3Tuple = [1, 0, 0];
    const intent = agentStateToIntent(undefined, self, state, 'follow_target', 7, null, meleeAim);
    // Target is at +X, expect yaw = atan2(1, 0) = π/2
    expect(intent.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('falls back to fireAim when meleeAim is null', () => {
    const state = createSteeringState();
    const self = makeSelf();
    const fireAim: Vec3Tuple = [5, 0, 0];
    const intent = agentStateToIntent(undefined, self, state, 'follow_target', 7, fireAim, null);
    expect(intent.firePrimary).toBe(true);
    expect(intent.meleePrimary).toBe(false);
  });
});
