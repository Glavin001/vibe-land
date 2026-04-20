import { describe, expect, it } from 'vitest';
import { BotPerception, DEFAULT_PERCEPTION_CONFIG, type PerceptionConfig, type RaycastFn } from './perception';
import type { BotSelfState, ObservedPlayer } from '../types';

function makeSelf(overrides: Partial<BotSelfState> = {}): BotSelfState {
  return {
    position: [0, 1, 0],
    velocity: [0, 0, 0],
    yaw: 0, // atan2(x, z) convention: 0 = facing +Z
    pitch: 0,
    onGround: true,
    dead: false,
    ...overrides,
  };
}

function player(id: number, pos: [number, number, number], isDead = false): ObservedPlayer {
  return { id, position: pos, isDead };
}

const TEST_CFG: PerceptionConfig = {
  ...DEFAULT_PERCEPTION_CONFIG,
  fovHalfAngleRad: Math.PI / 2, // 180° total cone
  perceptionRangeM: 50,
  memoryDurationTicks: 300,
  curiousDurationTicks: 120,
  perceptionRaycastCadenceTicks: 1,
};

describe('BotPerception FOV gating', () => {
  it('sees a player directly in front (inside 180° cone)', () => {
    const p = new BotPerception();
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10])],
      null,
      1,
      TEST_CFG,
    );
    expect(visible.map((v) => v.id)).toEqual([7]);
    expect(p.getMemory().has(7)).toBe(true);
  });

  it('does NOT see a player directly behind', () => {
    const p = new BotPerception();
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, -10])],
      null,
      1,
      TEST_CFG,
    );
    expect(visible).toEqual([]);
    expect(p.getMemory().has(7)).toBe(false);
  });

  it('does NOT see a player outside perception range', () => {
    const p = new BotPerception();
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 100])],
      null,
      1,
      TEST_CFG,
    );
    expect(visible).toEqual([]);
  });

  it('sees a player 89° off-axis but not 91° off-axis when cone is 180°', () => {
    const p = new BotPerception();
    // Slightly left-of-forward (angle ~89° from +Z) — should be visible.
    const nearEdge = Math.sin((89 * Math.PI) / 180) * 5;
    const nearEdgeZ = Math.cos((89 * Math.PI) / 180) * 5;
    // Slightly behind-of-side (angle ~91° from +Z) — should be hidden.
    const overEdge = Math.sin((91 * Math.PI) / 180) * 5;
    const overEdgeZ = Math.cos((91 * Math.PI) / 180) * 5;

    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [
        player(7, [nearEdge, 1, nearEdgeZ]),
        player(9, [overEdge, 1, overEdgeZ]),
      ],
      null,
      1,
      TEST_CFG,
    );
    const ids = visible.map((v) => v.id).sort();
    expect(ids).toEqual([7]);
  });

  it('excludes dead players', () => {
    const p = new BotPerception();
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10], true)],
      null,
      1,
      TEST_CFG,
    );
    expect(visible).toEqual([]);
  });
});

describe('BotPerception LOS gating', () => {
  it('rejects a player occluded by a wall closer than them', () => {
    const p = new BotPerception();
    // Target is ~10 m away; wall reported at 4 m.
    const raycast: RaycastFn = () => ({ toi: 4 });
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10])],
      raycast,
      1,
      TEST_CFG,
    );
    expect(visible).toEqual([]);
  });

  it('accepts a player when the raycast reports no hit', () => {
    const p = new BotPerception();
    const raycast: RaycastFn = () => null;
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10])],
      raycast,
      1,
      TEST_CFG,
    );
    expect(visible.map((v) => v.id)).toEqual([7]);
  });

  it('accepts a player when the raycast hit is beyond them (e.g. wall past target)', () => {
    const p = new BotPerception();
    const raycast: RaycastFn = () => ({ toi: 20 });
    const visible = p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10])],
      raycast,
      1,
      TEST_CFG,
    );
    expect(visible.map((v) => v.id)).toEqual([7]);
  });
});

describe('BotPerception memory', () => {
  it('retains a last-known position after the player leaves the FOV', () => {
    const p = new BotPerception();
    // Tick 1: player is in front, gets memorized.
    p.observe(
      makeSelf({ yaw: 0 }),
      [player(7, [0, 1, 10])],
      null,
      1,
      TEST_CFG,
    );
    // Tick 2: bot turned around (yaw = PI), same player is now behind.
    const visible = p.observe(
      makeSelf({ yaw: Math.PI }),
      [player(7, [0, 1, 10])],
      null,
      2,
      TEST_CFG,
    );
    expect(visible).toEqual([]);
    const memory = p.getMemory().get(7);
    expect(memory).toBeTruthy();
    expect(memory?.position).toEqual([0, 1, 10]);
    expect(memory?.seenAtTick).toBe(1);
  });

  it('prunes memory entries older than memoryDurationTicks', () => {
    const p = new BotPerception();
    p.observe(makeSelf({ yaw: 0 }), [player(7, [0, 1, 10])], null, 1, TEST_CFG);
    expect(p.getMemory().has(7)).toBe(true);
    // Advance past the memory window with no visible players.
    p.observe(makeSelf({ yaw: Math.PI }), [], null, 1 + TEST_CFG.memoryDurationTicks + 5, TEST_CFG);
    expect(p.getMemory().has(7)).toBe(false);
  });
});

describe('BotPerception curious-on-damage', () => {
  const cfg: PerceptionConfig = { ...TEST_CFG, curiousDurationTicks: 60 };

  it('enters curious window when HP drops and bot has no target', () => {
    const p = new BotPerception();
    p.noteHp(100, 1, /* hasTarget */ false, 0, cfg);
    p.noteHp(80, 2, /* hasTarget */ false, 0, cfg);
    expect(p.isCurious(2)).toBe(true);
    expect(p.isCurious(2 + cfg.curiousDurationTicks)).toBe(false);
  });

  it('does NOT enter curious when bot already has a target', () => {
    const p = new BotPerception();
    p.noteHp(100, 1, /* hasTarget */ true, 0, cfg);
    p.noteHp(80, 2, /* hasTarget */ true, 0, cfg);
    expect(p.isCurious(2)).toBe(false);
  });

  it('snap-180 yaw points directly behind at hit time', () => {
    const p = new BotPerception();
    p.noteHp(100, 1, false, 0, cfg);
    p.noteHp(80, 2, false, /* yaw */ 0, cfg);
    const look = p.getCuriousLookYaw(2);
    // Facing +Z (yaw=0) → behind is -Z (yaw = π or -π).
    expect(look).not.toBeNull();
    expect(Math.abs(Math.abs(look!) - Math.PI)).toBeLessThan(1e-6);
  });

  it('returns null once curious window ends', () => {
    const p = new BotPerception();
    p.noteHp(100, 1, false, 0, cfg);
    p.noteHp(80, 2, false, 0, cfg);
    expect(p.getCuriousLookYaw(2 + cfg.curiousDurationTicks + 1)).toBeNull();
  });
});
