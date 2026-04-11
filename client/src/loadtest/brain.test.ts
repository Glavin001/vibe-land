import { describe, expect, it } from 'vitest';
import { FLAG_ON_GROUND, type PlayerStateMeters } from '../net/protocol';
import { createBotBrainState, stepBotBrain } from './brain';
import { normalizeScenario } from './scenario';

function player(position: [number, number, number], flags = FLAG_ON_GROUND): PlayerStateMeters {
  return {
    position,
    velocity: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    hp: 100,
    flags,
  };
}

describe('bot brain', () => {
  it('follows the nearest player when safely on the arena', () => {
    const scenario = normalizeScenario({ botCount: 4, spawnPattern: 'clustered' });
    const state = createBotBrainState(0, scenario);
    const intent = stepBotBrain(state, scenario, player([0, 2, 0]), [
      { id: 2, state: player([5, 2, 0]) },
      { id: 3, state: player([9, 2, 0]) },
    ]);

    expect(intent.mode).toBe('follow_target');
    expect(intent.targetPlayerId).toBe(2);
    expect(intent.buttons).toBeGreaterThan(0);
  });

  it('recovers toward center when far outside the arena', () => {
    const scenario = normalizeScenario({ botCount: 4, spawnPattern: 'spread' });
    const state = createBotBrainState(0, scenario);
    const intent = stepBotBrain(state, scenario, player([80, 2, 0]), []);

    expect(intent.mode).toBe('recover_center');
    expect(intent.targetPlayerId).toBeNull();
  });
});
