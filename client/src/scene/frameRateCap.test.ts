import { describe, expect, it } from 'vitest';

import { frameRateCapFps, nextCapDeadline } from './frameRateCap';

describe('frameRateCapFps', () => {
  it('is off unless the URL asks', () => {
    expect(frameRateCapFps('')).toBeNull();
    expect(frameRateCapFps('?foo=1')).toBeNull();
    expect(frameRateCapFps('?maxFps=')).toBeNull();
    expect(frameRateCapFps('?maxFps=abc')).toBeNull();
    expect(frameRateCapFps('?maxFps=0')).toBeNull();
  });
  it('reads and clamps the cap', () => {
    expect(frameRateCapFps('?maxFps=30')).toBe(30);
    expect(frameRateCapFps('?maxFps=2')).toBe(10);
    expect(frameRateCapFps('?maxFps=1000')).toBe(240);
  });
});

describe('nextCapDeadline', () => {
  it('renders every second vsync of a 60 Hz display at a 30 fps cap', () => {
    const interval = 1000 / 30;
    let due = 0;
    const rendered: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      // 60 Hz rAF with a little jitter either side.
      const now = i * (1000 / 60) + (i % 2 === 0 ? 0.3 : -0.3);
      const next = nextCapDeadline(now, due, interval);
      if (next !== null) {
        due = next;
        rendered.push(i);
      }
    }
    expect(rendered.length).toBe(30);
    expect(rendered.every((v, k) => v === k * 2)).toBe(true);
  });
  it('does not schedule into the past after a stall', () => {
    const next = nextCapDeadline(500, 20, 1000 / 60);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(500);
  });
});
