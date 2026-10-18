import { describe, expect, it } from 'vitest';
import { GRASS_BRUSHES, GrassPaint } from './GrassPaint';
import { generateGrassPatch } from './grassPlacement';
import { FOLIAGE_SPECIES } from './foliageProfiles';

describe('foliage authoring and budgets', () => {
  it('keeps species categorical, deterministic and far below grass density for broad leaves', () => {
    const paint = new GrassPaint();
    for (const name of ['lush', 'reeds', 'wheat', 'corn', 'ferns']) {
      const brush = { ...GRASS_BRUSHES[name], rowSpacing: 0 };
      paint.paint(4, 4, 12, brush);
      const a = generateGrassPatch(0, 0, 'pretty', [], paint);
      const b = generateGrassPatch(0, 0, 'pretty', [], paint);
      expect(a.roots).toEqual(b.roots);
      expect(a.count).toBeGreaterThan(30);
      const species = FOLIAGE_SPECIES.indexOf(brush.species ?? 'grass');
      for (let i = 0; i < a.count; i++) expect(a.traits[i*4+3]).toBe(species);
      if (species >= 3) expect(a.count).toBeLessThan(400);
    }
    paint.dispose();
  });

  it('changes maturity without relocating roots and places crop rows in world space', () => {
    const paint = new GrassPaint();
    const brush = { ...GRASS_BRUSHES.corn, rowSpacing: 1, rowAngle: 0 };
    paint.paint(4, 4, 12, brush);
    const mature = generateGrassPatch(0, 0, 'pretty', [], paint);
    paint.paint(4, 4, 12, { ...brush, maturity: 0 });
    const young = generateGrassPatch(0, 0, 'pretty', [], paint);
    expect(young.count).toBe(mature.count);
    const spacing = Math.round(255/4)/255*4;
    for (let i = 0; i < young.count; i++) {
      const x = young.roots[i*4];
      expect(x).toBe(mature.roots[i*4]);
      expect(Math.abs(x/spacing-Math.round(x/spacing))*spacing).toBeLessThan(spacing*0.301);
      expect(young.roots[i*4+2]).toBeLessThan(mature.roots[i*4+2]*0.5);
    }
    paint.dispose();
  });

  it('keeps crop roots identical across quality tiers and supports appearance-only painting', () => {
    const paint = new GrassPaint();
    paint.paint(4,4,12,GRASS_BRUSHES.corn);
    const a = generateGrassPatch(0,0,'pretty',[],paint);
    const fast = generateGrassPatch(0,0,'fast',[],paint);
    expect(fast.roots).toEqual(a.roots);
    paint.paint(4,4,12,{...GRASS_BRUSHES.dry, mode:'appearance'});
    const b = generateGrassPatch(0,0,'pretty',[],paint);
    expect(b.roots).toEqual(a.roots);
    expect(b.colors).not.toEqual(a.colors);
    expect(b.traits[3]).toBe(3);
    paint.dispose();
  });

  it('validates species atomically and invalidates only changed tiles on shared imports', () => {
    const a = new GrassPaint(), b = new GrassPaint();
    a.paint(4, 4, 2, GRASS_BRUSHES.corn);
    a.paint(100, 100, 2, GRASS_BRUSHES.ferns);
    b.import(a.export());
    const bounds: number[] = [];
    b.subscribe(box => bounds.push(box.minX));
    b.import(a.export()); expect(bounds).toHaveLength(0);
    a.paint(4, 4, 2, GRASS_BRUSHES.wheat);
    b.import(a.export()); expect(bounds).toEqual([0]);
    const good = b.export(), bad = a.export(); bad.tiles[0].data[5] = 255;
    expect(() => b.import(bad)).toThrow('Invalid foliage species');
    expect(b.export()).toEqual(good);
    a.dispose(); b.dispose();
  });
});
