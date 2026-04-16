import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORLD_DOCUMENT,
  cloneWorldDocument,
  removeVehicleEntitiesFromWorldDocument,
} from './worldDocument';

describe('WorldDocument helpers', () => {
  it('removes authored vehicles for multiplayer prediction worlds', () => {
    const world = cloneWorldDocument(DEFAULT_WORLD_DOCUMENT);
    expect(world.dynamicEntities.some((entity) => entity.kind === 'vehicle')).toBe(true);

    const stripped = removeVehicleEntitiesFromWorldDocument(world);

    expect(stripped).not.toBe(world);
    expect(stripped.dynamicEntities.some((entity) => entity.kind === 'vehicle')).toBe(false);
    expect(stripped.dynamicEntities.length).toBeLessThan(world.dynamicEntities.length);
    expect(stripped.terrain).toBe(world.terrain);
    expect(stripped.staticProps).toBe(world.staticProps);
  });

  it('reuses worlds that do not contain authored vehicles', () => {
    const world = {
      ...cloneWorldDocument(DEFAULT_WORLD_DOCUMENT),
      dynamicEntities: [],
    };

    expect(removeVehicleEntitiesFromWorldDocument(world)).toBe(world);
  });
});
