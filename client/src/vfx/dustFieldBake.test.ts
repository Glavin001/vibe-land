import { describe, expect, it } from 'vitest';
import { buildTileableNoise, NOISE_SIZE, sharedTileableNoise } from './dustFieldBake';

describe('sharedTileableNoise', () => {
  it('builds the noise once per page and hands the same array back', () => {
    // A 64³ build is 40-85 ms of main thread; every volumetric renderer
    // rebuilt it, and the render governor recreates the renderer mid-storm.
    const first = sharedTileableNoise();
    expect(first.length).toBe(NOISE_SIZE ** 3);
    const started = performance.now();
    const second = sharedTileableNoise();
    expect(performance.now() - started).toBeLessThan(5);
    expect(second).toBe(first);
  });

  it('is the same noise buildTileableNoise makes', () => {
    expect(sharedTileableNoise(16, 7)).toEqual(buildTileableNoise(16, 7));
    expect(sharedTileableNoise(16, 8)).not.toEqual(sharedTileableNoise(16, 7));
  });
});
