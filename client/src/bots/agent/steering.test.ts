import { describe, expect, it } from 'vitest';

import { BTN_FORWARD, BTN_SPRINT } from '../../net/protocol';
import type { BotSelfState } from '../types';
import { agentStateToIntent, createSteeringState } from './steering';

function selfState(): BotSelfState {
  return {
    position: [0, 1, 0],
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    onGround: true,
    dead: false,
  };
}

describe('agentStateToIntent', () => {
  it('emits sprint when the target is more than 10 meters away', () => {
    const agent = {
      desiredVelocity: [0, 0, 1],
    } as Parameters<typeof agentStateToIntent>[0];

    const intent = agentStateToIntent(
      agent,
      selfState(),
      createSteeringState(),
      'follow_target',
      2,
      12,
      null,
    );

    expect(intent.buttons & BTN_FORWARD).toBe(BTN_FORWARD);
    expect(intent.buttons & BTN_SPRINT).toBe(BTN_SPRINT);
  });

  it('walks without sprint when the target is within 10 meters', () => {
    const agent = {
      desiredVelocity: [0, 0, 1],
    } as Parameters<typeof agentStateToIntent>[0];

    const intent = agentStateToIntent(
      agent,
      selfState(),
      createSteeringState(),
      'follow_target',
      2,
      8,
      null,
    );

    expect(intent.buttons & BTN_FORWARD).toBe(BTN_FORWARD);
    expect(intent.buttons & BTN_SPRINT).toBe(0);
  });
});
