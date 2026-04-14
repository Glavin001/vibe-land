import { describe, expect, it } from 'vitest';
import { BTN_FORWARD, BTN_SPRINT } from '../../net/protocol';
import type { BotSelfState } from '../types';
import { agentStateToIntent, createSteeringState } from './steering';

function selfAt(x: number, z: number, onGround = true): BotSelfState {
  return {
    position: [x, 1, z],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround,
    dead: false,
  };
}

function fakeAgent(desiredVelocity: [number, number, number]) {
  return {
    desiredVelocity,
    velocity: [0, 0, 0],
    position: [0, 0, 0],
  } as unknown as Parameters<typeof agentStateToIntent>[0];
}

describe('agentStateToIntent', () => {
  it('holds BTN_FORWARD when the agent wants to move at walking speed', () => {
    const state = createSteeringState();
    const intent = agentStateToIntent(
      fakeAgent([2, 0, 0]),
      selfAt(0, 0),
      state,
      'follow_target',
      null,
      null,
    );
    expect(intent.buttons & BTN_FORWARD).toBe(BTN_FORWARD);
    expect(intent.buttons & BTN_SPRINT).toBe(0);
  });

  it('never emits BTN_SPRINT (bot speed is controlled by the WASM override)', () => {
    const state = createSteeringState();
    const intent = agentStateToIntent(
      fakeAgent([9, 0, 0]),
      selfAt(0, 0),
      state,
      'follow_target',
      null,
      null,
    );
    expect(intent.buttons & BTN_FORWARD).toBe(BTN_FORWARD);
    expect(intent.buttons & BTN_SPRINT).toBe(0);
  });

  it('yaw faces desired velocity direction in XZ', () => {
    const state = createSteeringState();
    const intent = agentStateToIntent(
      fakeAgent([0, 0, 3]),
      selfAt(0, 0),
      state,
      'follow_target',
      null,
      null,
    );
    // atan2(0, 3) = 0 (facing +Z)
    expect(Math.abs(intent.yaw)).toBeLessThan(1e-6);
  });

  it('fire aim overrides yaw and sets firePrimary', () => {
    const state = createSteeringState();
    const intent = agentStateToIntent(
      fakeAgent([0, 0, 0]),
      selfAt(0, 0),
      state,
      'follow_target',
      7,
      [5, 1, 0],
    );
    expect(intent.firePrimary).toBe(true);
    // Target is +X direction → yaw = atan2(5, 0) = π/2
    expect(intent.yaw).toBeCloseTo(Math.PI / 2, 2);
    expect(intent.targetPlayerId).toBe(7);
  });

  it('emits no buttons when dead', () => {
    const state = createSteeringState();
    const intent = agentStateToIntent(
      fakeAgent([5, 0, 0]),
      { ...selfAt(0, 0), dead: true },
      state,
      'dead',
      null,
      null,
    );
    expect(intent.buttons).toBe(0);
    expect(intent.mode).toBe('dead');
  });
});
