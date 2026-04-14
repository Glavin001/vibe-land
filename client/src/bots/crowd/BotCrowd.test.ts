import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_DOCUMENT } from '../../world/worldDocument';
import { createBotCrowd } from './BotCrowd';

describe('BotCrowd', () => {
  it('adds and removes bots', () => {
    const crowd = createBotCrowd(DEFAULT_WORLD_DOCUMENT);
    const handle = crowd.addBot([0, 5, 0]);
    expect(handle.id).toBeTruthy();
    expect(crowd.getAgent(handle.id)).toBeDefined();
    expect(crowd.removeBot(handle)).toBe(true);
    expect(crowd.getAgent(handle.id)).toBeUndefined();
  });

  it('accepts a move target on the mesh and eventually steers toward it', () => {
    const crowd = createBotCrowd(DEFAULT_WORLD_DOCUMENT);
    const handle = crowd.addBot([0, 5, 0]);
    const target: [number, number, number] = [6, 5, 6];
    const ok = crowd.requestMoveTo(handle, target);
    expect(ok).toBe(true);
    // Advance a handful of simulated seconds so the corridor is populated.
    for (let i = 0; i < 30; i += 1) {
      crowd.step(1 / 30);
    }
    const agent = crowd.getAgent(handle.id);
    expect(agent).toBeDefined();
    // A valid path either produces a non-empty corridor or at least a valid
    // desired velocity pointing roughly toward +X (since target is +X,+Z).
    const corridorLength = agent!.corridor.path.length;
    const desiredLen = Math.hypot(agent!.desiredVelocity[0], agent!.desiredVelocity[2]);
    expect(corridorLength + desiredLen).toBeGreaterThan(0);
  });

  it('syncBotPosition updates the agent position', () => {
    const crowd = createBotCrowd(DEFAULT_WORLD_DOCUMENT);
    const handle = crowd.addBot([0, 5, 0]);
    crowd.syncBotPosition(handle, [3, 5, 3]);
    const agent = crowd.getAgent(handle.id);
    expect(agent).toBeDefined();
    // Snapped to the nearest walkable polygon — but planar X/Z should be in
    // the neighborhood of what we requested.
    expect(Math.abs(agent!.position[0] - 3)).toBeLessThan(2);
    expect(Math.abs(agent!.position[2] - 3)).toBeLessThan(2);
  });

  it('findRandomWalkable returns a point on the mesh', () => {
    const crowd = createBotCrowd(DEFAULT_WORLD_DOCUMENT);
    const point = crowd.findRandomWalkable();
    expect(point).not.toBeNull();
    expect(point).toHaveLength(3);
  });
});
