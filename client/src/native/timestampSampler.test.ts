import { describe, expect, it } from 'vitest';
import { createTimestampSampler } from './timestampSampler';

describe('createTimestampSampler', () => {
  it('keeps one readback in flight however many slow frames pass', async () => {
    let calls = 0;
    let settle: (ms: number) => void = () => {};
    const sampler = createTimestampSampler(() => {
      calls += 1;
      return new Promise<number>((resolve) => { settle = resolve; });
    }, 3);
    for (let frame = 0; frame < 300; frame++) sampler.tick();
    expect(calls).toBe(1);
    expect(sampler.pending).toBe(true);
    settle(4.5);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(sampler.pending).toBe(false);
    expect(sampler.ms).toBe(4.5);
    for (let frame = 0; frame < 3; frame++) sampler.tick();
    expect(calls).toBe(2);
  });

  it('samples every N frames and survives a rejected readback', async () => {
    let calls = 0;
    const sampler = createTimestampSampler(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('mapped')) : Promise.resolve(undefined);
    }, 5);
    for (let frame = 0; frame < 4; frame++) sampler.tick();
    expect(calls).toBe(0);
    sampler.tick();
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(sampler.pending).toBe(false);
    expect(sampler.ms).toBeNull();
    for (let frame = 0; frame < 5; frame++) sampler.tick();
    expect(calls).toBe(2);
  });
});
