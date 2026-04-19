import { describe, expect, it } from 'vitest';

import { arenaHarass, harassNearest } from './behaviors';
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
    const behavior = harassNearest({ acquireDistanceM: 40 });
    const decision = behavior(makeContext());

    expect(decision.mode).toBe('follow_target');
    expect(decision.targetPlayerId).toBe(7);
    expect(decision.target).toEqual([52, 1, -10]);
  });

  it('still follows on flat ground near y=0', () => {
    const behavior = harassNearest({ acquireDistanceM: 40 });
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
    const behavior = harassNearest({ acquireDistanceM: 40, releaseDistanceM: 65 });

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
    const behavior = harassNearest({ acquireDistanceM: 40, targetMemoryTicks: 5 });

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

  it('emits meleeAim and clears fireAim when target is within melee range', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, fireDistanceM: 18, meleeDistanceM: 2.0 });
    const decision = behavior(makeContext({
      self: {
        position: [50, 1, -10],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [{
        id: 7,
        position: [51.5, 1, -10],
        isDead: false,
      }],
    }));

    expect(decision.meleeAim).not.toBeNull();
    expect(decision.fireAim).toBeNull();
    expect(decision.targetPlayerId).toBe(7);
  });

  it('emits meleeAim against a vehicle target within the extended range', () => {
    const behavior = harassNearest({
      acquireDistanceM: 40,
      fireDistanceM: 18,
      meleeDistanceM: 2.0,
      meleeAgainstVehicleDistanceM: 3.0,
    });
    const decision = behavior(makeContext({
      self: {
        position: [50, 1, -10],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [{
        id: 7,
        position: [52.5, 1, -10],
        isDead: false,
        isInVehicle: true,
      }],
    }));

    expect(decision.meleeAim).not.toBeNull();
    expect(decision.fireAim).toBeNull();
  });

  it('returns to hold anchor after target memory expires', () => {
    const behavior = harassNearest({ acquireDistanceM: 40, targetMemoryTicks: 2 });

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

describe('arenaHarass', () => {
  it('follows the nearest player when safely on the arena', () => {
    const behavior = arenaHarass({ acquireDistanceM: 40, recoveryDistanceM: 32 });
    const decision = behavior({
      self: {
        position: [0, 2, 0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [
        { id: 2, position: [5, 2, 0], isDead: false },
        { id: 3, position: [9, 2, 0], isDead: false },
      ],
      anchor: [0, 2, 0],
      tick: 1,
    });

    expect(decision.mode).toBe('follow_target');
    expect(decision.targetPlayerId).toBe(2);
  });

  it('recovers toward center when far outside the arena', () => {
    const behavior = arenaHarass({ acquireDistanceM: 40, recoveryDistanceM: 32 });
    const decision = behavior({
      self: {
        position: [80, 2, 0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [],
      anchor: [80, 2, 0],
      tick: 1,
    });

    expect(decision.mode).toBe('recover_center');
    expect(decision.target).toEqual([0, 2, 0]);
    expect(decision.targetPlayerId).toBeNull();
  });

  it('recovers when below the floor regardless of arena distance', () => {
    const behavior = arenaHarass({ recoveryFloorY: 0.5 });
    const decision = behavior({
      self: {
        position: [3, 0.1, 3],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [{ id: 9, position: [4, 0.1, 3], isDead: false }],
      anchor: [3, 0.1, 3],
      tick: 1,
    });

    expect(decision.mode).toBe('recover_center');
  });

  it('emits fireAim against the nearest target inside fireDistance', () => {
    const behavior = arenaHarass({
      acquireDistanceM: 40,
      fireDistanceM: 20,
      meleeDistanceM: 1.0,
    });
    const decision = behavior({
      self: {
        position: [0, 2, 0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [{ id: 7, position: [3, 2, 0], isDead: false }],
      anchor: [0, 2, 0],
      tick: 1,
    });

    expect(decision.fireAim).toEqual([3, 2, 0]);
    expect(decision.targetPlayerId).toBe(7);
  });

  it('falls back to center as fire target when fireAtCenter is set', () => {
    const behavior = arenaHarass({
      acquireDistanceM: 40,
      fireDistanceM: 18,
      fireAtCenter: true,
    });
    const decision = behavior({
      self: {
        position: [3, 1.0, 0],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [],
      anchor: [3, 1.0, 0],
      tick: 1,
    });

    expect(decision.fireAim).toEqual([0, 1.0, 0]);
  });

  it('returns to center when idle and preferCenterWhenIdle is set', () => {
    const behavior = arenaHarass({
      acquireDistanceM: 5,
      preferCenterWhenIdle: true,
    });
    const decision = behavior({
      self: {
        position: [4, 1, 4],
        velocity: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        onGround: true,
        dead: false,
      },
      remotePlayers: [],
      anchor: [4, 1, 4],
      tick: 1,
    });

    expect(decision.mode).toBe('recover_center');
    expect(decision.target).toEqual([0, 1, 0]);
  });
});
