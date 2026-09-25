import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import type { CityManifest } from '../../city/manifest';
import { createBladeGeometry, GrassField } from './GrassField';
import {
  generateGrassPatch, grassExclusionsFromManifest, grassPatchDistance,
  grassDensityAtDistance, GRASS_PROFILES,
} from './grassPlacement';

describe('city grass placement', () => {
  it('regenerates identical blades and distributes low-density prefixes over the whole patch', () => {
    const a = generateGrassPatch(-3, 7, 'pretty', []);
    const b = generateGrassPatch(-3, 7, 'pretty', []);
    expect(a.roots).toEqual(b.roots);
    expect(a.shapes).toEqual(b.shapes);
    const quadrants = [0, 0, 0, 0];
    for (let i = 0; i < a.count * 0.1; i++) {
      quadrants[Number(a.roots[i * 4] >= 4) + 2 * Number(a.roots[i * 4 + 1] >= 4)]++;
    }
    for (const count of quadrants) expect(count).toBeGreaterThan(a.count * 0.018);
    expect(generateGrassPatch(-2, 7, 'pretty', []).roots).not.toEqual(a.roots);
  });

  it('keeps blades inside the city terrain and outside exclusion footprints at every LOD', () => {
    const exclusion = { minX: 1, minZ: 2, maxX: 6, maxZ: 7 };
    const data = generateGrassPatch(0, 0, 'pretty', [exclusion]);
    expect(data.count).toBeGreaterThan(0);
    for (let i = 0; i < data.count; i++) {
      const x = data.roots[i * 4], z = data.roots[i * 4 + 1];
      expect(x >= 1 && x <= 6 && z >= 2 && z <= 7).toBe(false);
    }
    expect(generateGrassPatch(32, 0, 'pretty', []).count).toBe(0);
    expect(generateGrassPatch(-33, 0, 'pretty', []).count).toBe(0);
    expect(generateGrassPatch(31, 0, 'pretty', []).count).toBeGreaterThan(0);
  });

  it('rotates and translates building footprints, including their actual extents', () => {
    const manifest = { structures: [{
      worldPosition: [10, 0, -5], worldRotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      chunks: [{ centroid: [2, 1, 0], size: [4, 2, 10] }],
    }] } as CityManifest;
    const [footprint] = grassExclusionsFromManifest(manifest);
    expect(footprint.minX).toBeCloseTo(4.35);
    expect(footprint.maxX).toBeCloseTo(15.65);
    expect(footprint.minZ).toBeCloseTo(-9.65);
    expect(footprint.maxZ).toBeCloseTo(-4.35);
  });

  it('uses a conservative minimum patch distance and monotonic density', () => {
    expect(grassPatchDistance(4, 0, 4, 0, 0)).toBe(0);
    expect(grassPatchDistance(-3, 0, -4, 0, 0)).toBe(5);
    expect(grassPatchDistance(4, 100, 4, 0, 0)).toBeGreaterThan(99);
    for (const quality of ['fast', 'pretty'] as const) {
      let last = 1;
      for (let d = 0; d < GRASS_PROFILES[quality].distance; d += 0.1) {
        const density = grassDensityAtDistance(d, quality);
        expect(density).toBeLessThanOrEqual(last);
        expect(density).toBeGreaterThan(0);
        last = density;
      }
    }
  });
});

describe('city grass rendering budget', () => {
  it('uses 7, 3 and 1 triangles with a single tapered tip', () => {
    for (const segments of [4, 2, 1]) {
      const geometry = createBladeGeometry(segments);
      expect(geometry.index!.count / 3).toBe(segments * 2 - 1);
      expect(geometry.getAttribute('position').count).toBe(segments * 2 + 1);
      geometry.dispose();
    }
  });

  it('bounds residency while travelling, culls aerial views, and releases all meshes', () => {
    const field = new GrassField('fast');
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 300);
    let time = 0;
    for (const x of [0, 64, -128, 240]) {
      camera.position.set(x, 1.7, 0);
      camera.lookAt(x, 1, -12);
      camera.updateMatrixWorld();
      for (let i = 0; i < 60; i++) field.update(camera, time += 0.05);
      expect(field.stats.patches).toBeLessThan(100);
      expect(field.stats.instanceBytes).toBeLessThan(7_000_000);
      expect(field.stats.visiblePatches).toBeGreaterThan(0);
      for (const child of field.group.children) {
        expect(child.castShadow).toBe(false);
      }
    }
    camera.position.y = 100;
    camera.updateMatrixWorld();
    field.update(camera, time += 1);
    expect(field.stats.visiblePatches).toBe(0);
    expect(field.stats.patches).toBe(0);
    field.dispose();
    expect(field.group.children).toHaveLength(0);
  });
});
