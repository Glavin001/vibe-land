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
    botId: 0,
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

  describe('chase offset (chaseOffsetRadiusM)', () => {
    it('bots with different ids choose different movement targets for the same player', () => {
      const behavior1 = harassNearest({ acquireDistanceM: 40, chaseOffsetRadiusM: 1.25 });
      const behavior2 = harassNearest({ acquireDistanceM: 40, chaseOffsetRadiusM: 1.25 });

      const d1 = behavior1(makeContext({ botId: 1_000_001 }));
      const d2 = behavior2(makeContext({ botId: 1_000_002 }));

      expect(d1.mode).toBe('follow_target');
      expect(d2.mode).toBe('follow_target');
      // Targets differ because each bot gets a unique angle
      expect(d1.target).not.toEqual(d2.target);
    });

    it('both targets remain within chaseOffsetRadiusM of the player center', () => {
      const radius = 1.25;
      const playerPos: [number, number, number] = [52, 1, -10];

      for (const botId of [1_000_001, 1_000_002, 1_000_003]) {
        const behavior = harassNearest({ acquireDistanceM: 40, chaseOffsetRadiusM: radius });
        const d = behavior(makeContext({ botId }));
        const dx = (d.target?.[0] ?? 0) - playerPos[0];
        const dz = (d.target?.[2] ?? 0) - playerPos[2];
        expect(Math.hypot(dx, dz)).toBeCloseTo(radius, 5);
      }
    });

    it('fireAim always points at the real player position regardless of offset', () => {
      const behavior = harassNearest({
        acquireDistanceM: 40,
        fireDistanceM: 18,
        chaseOffsetRadiusM: 1.25,
      });
      const playerPos: [number, number, number] = [52, 1, -10];
      const d = behavior(makeContext({ botId: 1_000_001 }));

      expect(d.fireAim).toEqual(playerPos);
      // movement target should differ from player center
      expect(d.target).not.toEqual(playerPos);
    });

    it('falls back to the real player position inside melee range (no offset)', () => {
      const behavior = harassNearest({
        acquireDistanceM: 40,
        meleeDistanceM: 2.0,
        chaseOffsetRadiusM: 1.25,
      });
      const playerPos: [number, number, number] = [51.5, 1, -10];
      const d = behavior(makeContext({
        botId: 1_000_001,
        self: { position: [50, 1, -10], velocity: [0, 0, 0], yaw: 0, pitch: 0, onGround: true, dead: false },
        remotePlayers: [{ id: 7, position: playerPos, isDead: false }],
      }));

      expect(d.meleeAim).toEqual(playerPos);
      expect(d.target).toEqual(playerPos);
    });

    it('zero chaseOffsetRadiusM targets the exact player center', () => {
      const behavior = harassNearest({ acquireDistanceM: 40, chaseOffsetRadiusM: 0 });
      const playerPos: [number, number, number] = [52, 1, -10];
      const d = behavior(makeContext({ botId: 1_000_001 }));
      expect(d.target).toEqual(playerPos);
    });
  });
});
