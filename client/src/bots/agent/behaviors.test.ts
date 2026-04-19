import { describe, expect, it } from 'vitest';

import { harassNearest } from './behaviors';
import type { BotBehaviorContext } from './behaviors';

function makeContext(overrides: Partial<BotBehaviorContext> = {}): BotBehaviorContext {
  return {
    self: {
      position: [48, 1, -12],
      velocity: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      onGround: true,
      dead: false,
    },
    remotePlayers: [{
      id: 7,
      position: [52, 1, -10],
      isDead: false,
    }],
    anchor: [50, 1, -10],
    tick: 1,
    ...overrides,
  };
}

describe('harassNearest', () => {
  it('holds anchor when the player is outside the acquire radius', () => {
    const behavior = harassNearest({ acquireDistanceM: 20 });
    const decision = behavior(makeContext({
      remotePlayers: [{
        id: 7,
        position: [90, 1, -10],
        isDead: false,
      }],
    }));

    expect(decision.mode).toBe('hold_anchor');
    expect(decision.target).toEqual([50, 1, -10]);
  });

  it('follows the nearest player when inside the acquire radius', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, fireDistanceM: 0 });
    const decision = behavior(makeContext());

    expect(decision.mode).toBe('follow_target');
    expect(decision.targetPlayerId).toBe(7);
    expect(decision.target).toEqual([52, 1, -10]);
  });

  it('stands to shoot once the player is inside the fire window', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, fireDistanceM: 18 });
    const decision = behavior(makeContext());

    expect(decision.mode).toBe('acquire_target');
    expect(decision.target).toBeNull();
    expect(decision.fireAim).toEqual([52, 1, -10]);
    expect(decision.targetPlayerId).toBe(7);
  });

  it('still follows on flat ground near y=0', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, fireDistanceM: 0 });
    const decision = behavior(makeContext({
      self: {
        position: [49, 0, -10],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [{
        id: 7,
        position: [50, 0, -9],
        isDead: false,
      }],
      anchor: [50, 0, -10],
    }));

    expect(decision.mode).toBe('follow_target');
    expect(decision.target).toEqual([50, 0, -9]);
  });

  it('keeps following a locked target slightly beyond acquire distance', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, releaseDistanceM: 65, fireDistanceM: 0 });

    let decision = behavior(makeContext({
      tick: 1,
      remotePlayers: [{
        id: 7,
        position: [52, 1, -10],
        isDead: false,
      }],
    }));
    expect(decision.mode).toBe('follow_target');

    decision = behavior(makeContext({
      tick: 2,
      remotePlayers: [{
        id: 7,
        position: [98, 1, -10],
        isDead: false,
      }],
    }));
    expect(decision.mode).toBe('follow_target');
    expect(decision.targetPlayerId).toBe(7);
    expect(decision.target).toEqual([98, 1, -10]);
  });

  it('keeps following the last known target through brief observation gaps', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, targetMemoryTicks: 5, fireDistanceM: 0 });

    let decision = behavior(makeContext({
      tick: 1,
      remotePlayers: [{
        id: 7,
        position: [52, 1, -10],
        isDead: false,
      }],
    }));
    expect(decision.mode).toBe('follow_target');

    decision = behavior(makeContext({
      tick: 2,
      remotePlayers: [],
    }));
    expect(decision.mode).toBe('follow_target');
    expect(decision.targetPlayerId).toBe(7);
    expect(decision.target).toEqual([52, 1, -10]);
  });

  it('returns to hold anchor after target memory expires', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, targetMemoryTicks: 2, fireDistanceM: 0 });

    let decision = behavior(makeContext({
      tick: 1,
      remotePlayers: [{
        id: 7,
        position: [52, 1, -10],
        isDead: false,
      }],
    }));
    expect(decision.mode).toBe('follow_target');

    decision = behavior(makeContext({
      tick: 5,
      remotePlayers: [],
    }));
    expect(decision.mode).toBe('hold_anchor');
    expect(decision.target).toEqual([50, 1, -10]);
  });
});
