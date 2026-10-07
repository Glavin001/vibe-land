import { describe, expect, it } from 'vitest';

import { MATTER_PRESETS, matterForAppearance } from './appearanceMatter';
import { validateRecipe } from './recipes';

const kindOf = (name: string, extra: Record<string, unknown> = {}) =>
  matterForAppearance({ name, ...extra })?.recipe.kind ?? null;

describe('city material -> Matter look', () => {
  it('dresses the kitchen: marble counters, a steel fridge, steel fittings', () => {
    expect(matterForAppearance({ name: 'marble-countertop' })?.name).toBe('marble-countertop');
    expect(kindOf('insulated-appliance-panel')).toBe('steel');
    expect(kindOf('metal')).toBe('steel');
  });

  it('makes timber wood and steel steel, wherever they are authored', () => {
    expect(matterForAppearance({ name: 'warm-oak' })?.name).toBe('oak');
    expect(matterForAppearance({ name: 'structure-timber' })?.name).toBe('pine');
    expect(matterForAppearance({ name: 'stud-timber' })?.name).toBe('pine');
    expect(matterForAppearance({ name: 'steel' })?.name).toBe('structural-steel');
    expect(kindOf('wall-tie')).toBe('steel');
  });

  it('makes structural concrete concrete', () => {
    expect(kindOf('footing')).toBe('concrete');
    expect(matterForAppearance({ name: 'reinforced-concrete' })?.name).toBe('white-concrete');
    expect(kindOf('concrete-slab')).toBe('concrete');
  });

  it('leaves painted, plastered and composite surfaces on their textures', () => {
    for (const name of ['painted-siding', 'plaster', 'drywall', 'brick-plinth', 'brick-veneer', 'slate-roof',
      'dark-joinery', 'particleboard-flooring', 'plastered-timber-wall', 'painted-outdoor-steel', 'timber-joint', 'mortar-joint', 'town-paving', 'porcelain']) {
      expect(kindOf(name), name).toBeNull();
    }
  });

  it('only makes transparent glass glass', () => {
    expect(kindOf('window-glass', { opacity: 0.24 })).toBe('glass');
    expect(kindOf('window-glass')).toBeNull();
  });

  it('lets a pack override by preset or by kind, and refuses an invalid recipe', () => {
    expect(matterForAppearance({ name: 'plaster', matter: { preset: 'oak', seed: 5 } })?.recipe.seed).toBe(5);
    const steel = matterForAppearance({ name: 'x', matter: { kind: 'steel', scale: 2, axis: 'y' } });
    expect(steel?.recipe.scale).toBe(2);
    expect(steel?.axis).toBe('y');
    expect(matterForAppearance({ name: 'x', matter: { kind: 'steel', scale: 99 } })).toBeNull();
  });

  it('every preset is a valid recipe', () => {
    for (const [name, preset] of Object.entries(MATTER_PRESETS)) {
      expect(() => validateRecipe(preset), name).not.toThrow();
    }
  });
});
