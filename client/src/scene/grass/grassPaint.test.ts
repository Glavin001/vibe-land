import { describe, expect, it } from 'vitest';
import { Color, PerspectiveCamera } from 'three';
import { GrassField } from './GrassField';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';
import { generateGrassPatch } from './grassPlacement';

describe('grass authoring', () => {
  it('paints continuous density, height and linear colour across positive and negative tile borders', () => {
    const paint = new GrassPaint(), a: number[] = [], b: number[] = [];
    for (const border of [-8, 0, 8]) {
      paint.paint(border, 0, 3, GRASS_BRUSHES.tall);
      paint.sampler(border/8-1, 0)(8, 0, a);
      paint.sampler(border/8, 0)(0, 0, b);
      expect(a).toEqual(b);
      expect(a[0]).toBe(1);
      expect(a[1]*2).toBeCloseTo(1.25, 2);
      expect(a[2]).toBeCloseTo(new Color(GRASS_BRUSHES.tall.color).r, 2);
    }
    paint.dispose();
  });

  it('makes bare ground truly empty and preserves placement when changing height or colour', () => {
    const paint = new GrassPaint();
    paint.paint(4, 4, 12, GRASS_BRUSHES.bare);
    expect(generateGrassPatch(0, 0, 'pretty', [], paint).count).toBe(0);
    paint.paint(4, 4, 12, GRASS_BRUSHES.tall);
    const tall = generateGrassPatch(0, 0, 'fast', [], paint);
    paint.paint(4, 4, 12, { ...GRASS_BRUSHES.dry, density: 1 });
    const dry = generateGrassPatch(0, 0, 'fast', [], paint);
    expect(dry.count).toBe(tall.count);
    expect(tall.maxHeight).toBeGreaterThan(1);
    expect(dry.maxHeight).toBeLessThan(0.61);
    expect(dry.colors).not.toEqual(tall.colors);
    for (let i = 0; i < tall.count; i++) {
      expect(tall.roots[i*4]).toBe(dry.roots[i*4]);
      expect(tall.roots[i*4+1]).toBe(dry.roots[i*4+1]);
    }
    paint.dispose();
  });

  it('round-trips sparse layouts and rejects invalid imports atomically', () => {
    const paint = new GrassPaint(), loaded = new GrassPaint();
    expect(paint.export().tiles).toHaveLength(0);
    paint.paint(-4, 4, 2, GRASS_BRUSHES.dry);
    const doc = paint.export();
    expect(doc.tiles).toHaveLength(1);
    loaded.import(JSON.parse(JSON.stringify(doc)));
    expect(loaded.export()).toEqual(doc);
    expect(() => loaded.import({ version: 1, tiles: [doc.tiles[0], null] })).toThrow();
    expect(loaded.export()).toEqual(doc);
    expect(() => loaded.import({ version: 1, tiles: [{ ...doc.tiles[0], x: 32 }] })).toThrow();
    loaded.paint(900, 0, 2, GRASS_BRUSHES.bare);
    expect(loaded.export()).toEqual(doc);
    paint.dispose(); loaded.dispose();
  });

  it('rebuilds visible patches after painting and keeps the distant ground cover consistent', () => {
    const paint = new GrassPaint();
    const field = new GrassField('fast', [], paint);
    const camera = new PerspectiveCamera(60, 1.6, 0.1, 300);
    camera.position.set(4, 2, 12); camera.lookAt(4, 0, 0); camera.updateMatrixWorld();
    for (let i = 0; i < 60; i++) field.update(camera, i/20);
    const patch = () => field.group.children.find(mesh => mesh.position.x === 0 && mesh.position.z === 0)!;
    expect(patch()).toBeDefined();
    const before = patch();
    paint.paint(4, 4, 12, GRASS_BRUSHES.bare);
    for (let i = 60; i < 120; i++) field.update(camera, i/20);
    expect(patch()).not.toBe(before);
    expect(patch().visible).toBe(false);
    const cover = paint.cover.image.data;
    expect(cover[(130*256+130)*4+3]).toBe(0);
    field.dispose(); paint.dispose();
  });
});
