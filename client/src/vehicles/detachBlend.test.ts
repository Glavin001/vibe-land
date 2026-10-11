import { describe, expect, it } from 'vitest';
import { DETACH_BLEND_MS, DetachBlend } from './detachBlend';

describe('parts leaving the driven car', () => {
  // The driven car is drawn 2 m ahead of where its loose part's track has the
  // part: the part starts on the car, then reaches its track in one blend.
  it('start where they were drawn on the car and blend onto their track', () => {
    const blend = new DetachBlend();
    const car = { position: [12, 0.5, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number] };
    const part = { part: 3, position: [10, 0.5, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const [first] = blend.apply(0, car, [part]);
    expect(first.position).toEqual([12, 0.5, 0]);
    const [mid] = blend.apply(DETACH_BLEND_MS / 2, car, [part]);
    expect(mid.position[0]).toBeCloseTo(11, 6);
    const [done] = blend.apply(DETACH_BLEND_MS, car, [part]);
    expect(done.position).toEqual([10, 0.5, 0]);
    // A part already loose is not blended again.
    const [later] = blend.apply(DETACH_BLEND_MS * 2, { ...car, position: [30, 0.5, 0] }, [part]);
    expect(later.position).toEqual([10, 0.5, 0]);
  });

  it('turn from the car to their own rotation the short way', () => {
    const blend = new DetachBlend();
    const s = Math.SQRT1_2;
    const car = { position: [0, 0, 0] as [number, number, number], quaternion: [0, s, 0, s] as [number, number, number, number] };
    const part = { part: 1, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const [first] = blend.apply(0, car, [part]);
    expect(first.rotation[1]).toBeCloseTo(s, 6);
    expect(first.rotation[3]).toBeCloseTo(s, 6);
    const [mid] = blend.apply(DETACH_BLEND_MS / 2, car, [part]);
    // Half of 90 degrees about y.
    expect(mid.rotation[1]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
  });
});
