import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD_DOCUMENT } from '../../world/worldDocument';
import { PracticeBotRuntime } from './PracticeBotRuntime';

// The runtime is designed to attach to a live NetcodeClient + LocalPreviewTransport.
// Those require WASM + DOM-style timers, so we test only the lifecycle paths
// that work in isolation (crowd spawning, behavior swaps, max speed, clear).
// End-to-end bot-in-scene behavior is covered by smoke-running the session.

describe('PracticeBotRuntime (detached)', () => {
  it('spawns bots into the crowd without a session', () => {
    const runtime = new PracticeBotRuntime(DEFAULT_WORLD_DOCUMENT);
    runtime.setBotCount(3);
    expect(runtime.count).toBe(3);
    expect(runtime.stats().bots).toBe(3);
    expect(runtime.stats().running).toBe(false);
  });

  it('setBotCount shrinks and clears correctly', () => {
    const runtime = new PracticeBotRuntime(DEFAULT_WORLD_DOCUMENT);
    runtime.setBotCount(4);
    expect(runtime.count).toBe(4);
    runtime.setBotCount(1);
    expect(runtime.count).toBe(1);
    runtime.clear();
    expect(runtime.count).toBe(0);
  });

  it('setBehavior reassigns all existing bots', () => {
    const runtime = new PracticeBotRuntime(DEFAULT_WORLD_DOCUMENT, { initialBehavior: 'harass' });
    runtime.setBotCount(2);
    runtime.setBehavior('wander');
    expect(runtime.stats().behavior).toBe('wander');
    runtime.setBehavior('hold');
    expect(runtime.stats().behavior).toBe('hold');
  });

  it('setMaxSpeed clamps and applies to existing agents', () => {
    const runtime = new PracticeBotRuntime(DEFAULT_WORLD_DOCUMENT);
    runtime.setBotCount(2);
    runtime.setMaxSpeed(9);
    expect(runtime.stats().maxSpeed).toBe(9);
    runtime.setMaxSpeed(100);
    expect(runtime.stats().maxSpeed).toBeLessThanOrEqual(12);
    runtime.setMaxSpeed(0);
    expect(runtime.stats().maxSpeed).toBeGreaterThanOrEqual(0.5);
  });

  it('detach is a no-op when never attached', () => {
    const runtime = new PracticeBotRuntime(DEFAULT_WORLD_DOCUMENT);
    runtime.setBotCount(1);
    runtime.detach();
    expect(runtime.count).toBe(1);
    expect(runtime.stats().running).toBe(false);
  });
});
