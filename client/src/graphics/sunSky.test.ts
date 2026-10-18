// Sun/sky math. Pure functions, so this covers the parts that decide whether
// shadows land in the right place and whether the skylight matches the weather
// without needing a WebGL context.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SUN_ELEVATION_DEG,
  shadowFocusPoint,
  shadowTexelSize,
  skyGradient,
  snapToStep,
  sunDirection,
  sunIntensityFor,
  sunPosition,
} from './sunSky';

describe('sunDirection', () => {
  it('is a unit vector', () => {
    for (const [el, az] of [
      [0, 0],
      [39, 70],
      [12, 200],
      [89, -140],
    ]) {
      const d = sunDirection(el, az);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
    }
  });

  it('uses the same azimuth convention as the wind (0 = +Z, 90 = +X)', () => {
    const north = sunDirection(0, 0);
    expect(north.z).toBeCloseTo(1, 6);
    const east = sunDirection(0, 90);
    expect(east.x).toBeCloseTo(1, 6);
  });

  it('reproduces the light direction the scene shipped with', () => {
    // The old hard-coded shadow light sat at [48, 42, 18]. Keeping the default
    // angles on that direction means this change reads as better ambient, not
    // as the key light jumping across the sky.
    const previous = { x: 48, y: 42, z: 18 };
    const length = Math.hypot(previous.x, previous.y, previous.z);
    const d = sunDirection();
    expect(d.x).toBeCloseTo(previous.x / length, 2);
    expect(d.y).toBeCloseTo(previous.y / length, 2);
    expect(d.z).toBeCloseTo(previous.z / length, 2);
  });

  it('places the sun above the horizon at the default elevation', () => {
    expect(sunPosition()[1]).toBeGreaterThan(0);
  });
});

describe('skyGradient', () => {
  it('is brighter at the zenith than at the ground', () => {
    const { zenith, ground } = skyGradient('#b7c7d8');
    const luminance = (hex: string) =>
      Number.parseInt(hex.slice(1, 3), 16) +
      Number.parseInt(hex.slice(3, 5), 16) +
      Number.parseInt(hex.slice(5, 7), 16);
    expect(luminance(zenith)).toBeGreaterThan(luminance(ground));
  });

  it('pulls the horizon toward the weather fog colour', () => {
    // A dust storm has to light the world with brown skylight; if the horizon
    // stayed blue the fill would fight the fog it fades into.
    const dust = skyGradient('#b89968');
    const clear = skyGradient('#b7c7d8');
    const red = (hex: string) => Number.parseInt(hex.slice(1, 3), 16);
    const blue = (hex: string) => Number.parseInt(hex.slice(5, 7), 16);
    expect(red(dust.horizon) - blue(dust.horizon)).toBeGreaterThan(
      red(clear.horizon) - blue(clear.horizon),
    );
  });

  it('warms the sun as it drops toward the horizon', () => {
    const warmth = (hex: string) =>
      Number.parseInt(hex.slice(1, 3), 16) - Number.parseInt(hex.slice(5, 7), 16);
    expect(warmth(skyGradient('#b7c7d8', 8).sunColor)).toBeGreaterThan(
      warmth(skyGradient('#b7c7d8', 60).sunColor),
    );
  });

  it('tolerates short hex and garbage colours', () => {
    expect(skyGradient('#abc').horizon).toMatch(/^#[0-9a-f]{6}$/);
    expect(skyGradient('not a colour').horizon).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('sunIntensityFor', () => {
  it('rises with the sun', () => {
    expect(sunIntensityFor(60)).toBeGreaterThan(sunIntensityFor(10));
    expect(sunIntensityFor(DEFAULT_SUN_ELEVATION_DEG)).toBeGreaterThan(0);
  });
});

describe('shadow frustum', () => {
  it('reports the world size of a shadow-map texel', () => {
    expect(shadowTexelSize(48, 2048)).toBeCloseTo(96 / 2048, 9);
    // Halving the frustum doubles the density for the same texel budget --
    // the whole reason the shadow camera follows the player.
    expect(shadowTexelSize(24, 2048)).toBeCloseTo(shadowTexelSize(48, 2048) / 2, 9);
  });

  it('snaps to the grid, including negatives', () => {
    expect(snapToStep(0.7, 0.5)).toBeCloseTo(0.5, 9);
    expect(snapToStep(-0.7, 0.5)).toBeCloseTo(-0.5, 9);
    expect(snapToStep(12.3, 0)).toBe(12.3);
  });

  it('leads the focus point in the direction the player is looking', () => {
    const focus = shadowFocusPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 48);
    expect(focus.z).toBeLessThan(0);
    expect(Math.abs(focus.x)).toBeLessThan(1e-3);
  });

  it('ignores the vertical part of the view direction', () => {
    // Looking at the sky must not tip the frustum off the ground the player is
    // standing on.
    const flat = shadowFocusPoint({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 48);
    const up = shadowFocusPoint({ x: 0, y: 0, z: 0 }, { x: 1, y: 4, z: 0 }, 48);
    expect(up.x).toBeCloseTo(flat.x, 3);
    expect(up.y).toBeCloseTo(flat.y, 3);
  });

  it('leads by a fraction of the frustum, so the player stays inside it', () => {
    const halfExtent = 48;
    const focus = shadowFocusPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, halfExtent);
    expect(Math.abs(focus.z)).toBeLessThan(halfExtent);
  });

  it('does not lead a zero view direction anywhere', () => {
    const focus = shadowFocusPoint({ x: 3, y: 1, z: -2 }, { x: 0, y: 0, z: 0 }, 48);
    expect(focus.x).toBeCloseTo(3, 3);
    expect(focus.z).toBeCloseTo(-2, 3);
  });
});
