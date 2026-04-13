import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initWasmForTests, WasmSimWorld } from '../wasm/testInit';
import { DynamicBodyPredictionManager } from './dynamicBodyPredictionManager';

const FIXED_DT = 1 / 60;

beforeAll(async () => {
  await initWasmForTests();
});

describe('DynamicBodyPredictionManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps proxy-stepping a recently shot body until it settles', () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const sim = new WasmSimWorld();
    const manager = new DynamicBodyPredictionManager(sim);

    manager.syncAuthoritativeBodies([{
      id: 1,
      shapeType: 1,
      position: [0, 10, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      halfExtents: [0.5, 0, 0],
    }]);

    const applied = sim.applyDynamicBodyImpulse(1, 5, 0, 0, 0, 10, 0);
    expect(applied).toBe(true);
    manager.markRecentInteraction(1, nowMs);

    for (let step = 0; step < 30; step += 1) {
      nowMs += FIXED_DT * 1000;
      manager.advance(FIXED_DT, true);
    }
    const posAtWindowEnd = sim.getDynamicBodyState(1);
    expect(posAtWindowEnd.length).toBeGreaterThanOrEqual(13);

    for (let step = 0; step < 12; step += 1) {
      nowMs += FIXED_DT * 1000;
      manager.advance(FIXED_DT, true);
    }
    const posAfterWindow = sim.getDynamicBodyState(1);
    expect(posAfterWindow.length).toBeGreaterThanOrEqual(13);

    const continuedDistance = Math.hypot(
      posAfterWindow[0] - posAtWindowEnd[0],
      posAfterWindow[1] - posAtWindowEnd[1],
      posAfterWindow[2] - posAtWindowEnd[2],
    );
    expect(continuedDistance).toBeGreaterThan(0.02);

    manager.clear();
    sim.free();
  });

  it('raycasts against moved dynamic proxy bodies immediately after authoritative sync', () => {
    const sim = new WasmSimWorld();
    const manager = new DynamicBodyPredictionManager(sim);

    manager.syncAuthoritativeBodies([{
      id: 1,
      shapeType: 1,
      position: [0, 10, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      halfExtents: [0.5, 0, 0],
    }]);

    manager.syncAuthoritativeBodies([{
      id: 1,
      shapeType: 1,
      position: [3, 10, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      halfExtents: [0.5, 0, 0],
    }]);

    const hit = sim.castDynamicBodyRay(3, 10, -5, 0, 0, 1, 10);
    expect(hit.length).toBeGreaterThanOrEqual(5);
    expect(hit[0]).toBe(1);

    manager.clear();
    sim.free();
  });

  it('snaps a ghost-predicted body back when authority says it stayed settled', () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const sim = new WasmSimWorld();
    const manager = new DynamicBodyPredictionManager(sim);

    manager.syncAuthoritativeBodies([{
      id: 5,
      shapeType: 1,
      position: [0, 10, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      halfExtents: [0.5, 0, 0],
    }]);

    const applied = sim.applyDynamicBodyImpulse(5, 5, 0, 0, 0, 10, 0);
    expect(applied).toBe(true);
    manager.markRecentInteraction(5, nowMs);
    sim.stepDynamics(FIXED_DT);

    const movedState = manager.getPhysicsBodyState(5);
    expect(movedState).not.toBeNull();
    expect(movedState!.position[0]).toBeGreaterThan(0.05);

    manager.syncAuthoritativeBodies([{
      id: 5,
      shapeType: 1,
      position: [0, 10, 0],
      quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      halfExtents: [0.5, 0, 0],
    }]);

    const snappedState = manager.getPhysicsBodyState(5);
    expect(snappedState).not.toBeNull();
    expect(Math.abs(snappedState!.position[0])).toBeLessThan(0.01);
    expect(manager.getRecentInteractionCount(nowMs)).toBe(0);

    manager.clear();
    sim.free();
  });
});
