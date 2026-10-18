import { describe, expect, it } from 'vitest';

import {
  applySampleBudget,
  drawnAtTier,
  easeSteps,
  fogCullDistance,
  layerBlendFor,
  pixelsPerMetre,
  sortBackToFront,
  stepsFor,
  tierFor,
  type DustDrawItem,
} from './dustLod';

const item = (over: Partial<DustDrawItem>): DustDrawItem => ({
  slot: 0, distance: 10, projectedPx: 100, tier: 0, steps: 48, layerBlend: 1, densityScale: 1, ...over,
});

describe('dust LOD', () => {
  it('culls at the distance where fog has taken the picture', () => {
    // The city's default fog, from the 80 m area of interest.
    expect(fogCullDistance(0.0112)).toBeCloseTo(167, 0);
    // Aerial mode thins the fog to 0.001.
    expect(fogCullDistance(0.001)).toBeCloseTo(1872.6, 0);
    expect(fogCullDistance(0)).toBe(Infinity);
  });

  it('tiers by distance, but keeps a big cloud near', () => {
    expect(tierFor(20, 1)).toBe(0);
    expect(tierFor(100, 1)).toBe(1);
    expect(tierFor(100, 30)).toBe(0);
    expect(tierFor(300, 1)).toBe(2);
  });

  it('thins by stable serial so a drawn parcel stays drawn', () => {
    expect(drawnAtTier(12, 2)).toBe(true);
    expect(drawnAtTier(11, 2)).toBe(false);
    expect(drawnAtTier(11, 0)).toBe(true);
    // Whatever is drawn at a far tier is drawn at every nearer one.
    for (let serial = 0; serial < 100; serial += 1) {
      if (drawnAtTier(serial, 2)) {
        expect(drawnAtTier(serial, 1)).toBe(true);
        expect(drawnAtTier(serial, 0)).toBe(true);
      }
    }
  });

  it('spends steps by tier and projected size', () => {
    expect(stepsFor(0, 1000)).toBe(48);
    expect(stepsFor(2, 1000)).toBe(12);
    expect(stepsFor(0, 20)).toBe(8);
    expect(stepsFor(0, 50)).toBe(20);
  });

  it('eases step changes and snaps from zero', () => {
    expect(easeSteps(0, 48, 0.016)).toBe(48);
    const eased = easeSteps(48, 12, 0.016);
    expect(eased).toBeLessThan(48);
    expect(eased).toBeGreaterThan(40);
    expect(easeSteps(48, 12, 5)).toBeCloseTo(12, 3);
  });

  it('holds the sample budget by scaling steps, then shedding the far end', () => {
    const viewport = 1920 * 1080;
    const items = [
      item({ distance: 10, projectedPx: 1000, steps: 48 }),
      item({ distance: 50, projectedPx: 500, steps: 48 }),
      item({ distance: 200, projectedPx: 300, steps: 12 }),
    ];
    const unconstrained = applySampleBudget(items.map((i) => ({ ...i })), Infinity, viewport);
    expect(unconstrained).toBeGreaterThan(50e6);
    const scaled = items.map((i) => ({ ...i }));
    const estimate = applySampleBudget(scaled, 12e6, viewport);
    expect(estimate).toBeLessThanOrEqual(12e6 + 1);
    expect(scaled).toHaveLength(3);
    expect(scaled[0].steps).toBeLessThan(48);
    expect(scaled[0].steps).toBeGreaterThanOrEqual(6);
    // Floor everything and still over: the far end goes half-res first.
    const demoted = items.map((i) => ({ ...i }));
    applySampleBudget(demoted, 8e6, viewport);
    expect(demoted).toHaveLength(3);
    expect(demoted[2].layerBlend).toBe(0);
    expect(demoted[0].layerBlend).toBe(1);
    // Half-res everywhere and still over: the farthest is dropped first.
    const shed = items.map((i) => ({ ...i }));
    applySampleBudget(shed, 1.9e6, viewport);
    expect(shed.length).toBeLessThan(3);
    expect(shed[0].distance).toBe(10);
    // Never shed the nearest, however small the budget.
    const starved = items.map((i) => ({ ...i }));
    applySampleBudget(starved, 1, viewport);
    expect(starved).toHaveLength(1);
  });

  it('caps a parcel covering the whole screen at the viewport, not its projected square', () => {
    const viewport = 1920 * 1080;
    const items = [item({ projectedPx: 100_000, steps: 6 })];
    expect(applySampleBudget(items, Infinity, viewport)).toBe(viewport * 6);
  });

  it('routes far and screen-filling parcels to the half-res layer with a blend band', () => {
    const viewport = 1920 * 1080;
    expect(layerBlendFor(30, 2, 200, viewport)).toBe(1);
    expect(layerBlendFor(200, 2, 20, viewport)).toBe(0);
    const mid = layerBlendFor(105, 0, 20, viewport);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Surface distance: a 40 m cloud whose centre is 100 m away is 60 m away.
    expect(layerBlendFor(100, 40, 400, viewport)).toBe(1);
    // Filling the view keeps it native: the budget, not the layer, bounds that.
    expect(layerBlendFor(5, 3, 1500, viewport)).toBe(1);
  });

  it('projects size with the camera fov', () => {
    // 1080 px tall at fov 75: ~704 px per metre at one metre.
    expect(pixelsPerMetre(75, 1080)).toBeCloseTo(703.6, 0);
  });

  it('sorts back to front', () => {
    const items = [item({ distance: 5 }), item({ distance: 50 }), item({ distance: 20 })];
    sortBackToFront(items);
    expect(items.map((i) => i.distance)).toEqual([50, 20, 5]);
  });
});
