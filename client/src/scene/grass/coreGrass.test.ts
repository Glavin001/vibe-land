import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initSync } from '../../wasm/core-pkg/vibe_client_core_wasm.js';
import { GrassPaint, GRASS_BRUSHES } from './GrassPaint';
import { generateCoreGrassPatch } from './coreGrass';
import { generateGrassPatch, type GrassExclusion, type GrassPatchData, type GrassQuality } from './grassPlacement';

const here = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  initSync({ module: readFileSync(join(here, '../../wasm/core-pkg/vibe_client_core_wasm_bg.wasm')) });
});

/** Same blades, in the same order; f32 against f64 arithmetic moves a packed unorm by one step
 * at most, and positions by under 1e-4 m. */
function expectSamePatch(core: GrassPatchData, web: GrassPatchData): void {
  expect(core.count).toBe(web.count);
  expect(Math.abs(core.maxHeight - web.maxHeight)).toBeLessThan(1e-4);
  const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    let d = 0;
    for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
  };
  expect(core.roots.length).toBe(web.roots.length);
  expect(maxDiff(core.roots, web.roots)).toBeLessThan(1e-4);
  expect(maxDiff(core.shapes, web.shapes)).toBeLessThanOrEqual(1);
  expect(maxDiff(core.colors, web.colors)).toBeLessThanOrEqual(1);
  expect(maxDiff(core.traits, web.traits)).toBeLessThanOrEqual(1);
  // Species are categorical: exactly equal.
  for (let i = 3; i < core.traits.length; i += 4) expect(core.traits[i]).toBe(web.traits[i]);
}

describe('grass patches from the shared core (?coreGrass=1)', () => {
  const qualities: GrassQuality[] = ['pretty', 'fast'];
  it('matches generateGrassPatch on the default meadow at every quality', () => {
    const paint = new GrassPaint();
    for (const quality of qualities) {
      for (const [px, pz] of [[0, 0], [3, -2], [-31, 31], [12, 7]]) {
        expectSamePatch(generateCoreGrassPatch(px, pz, quality, [], paint.patchDocument(px, pz)),
          generateGrassPatch(px, pz, quality, [], paint));
      }
    }
    paint.dispose();
  });

  it('matches it over painted species, crop rows and footprints', () => {
    const paint = new GrassPaint();
    paint.paint(2, 2, 2.5, GRASS_BRUSHES.wheat);
    paint.paint(6, 2, 2.5, GRASS_BRUSHES.corn);
    paint.paint(2, 6, 2.5, GRASS_BRUSHES.reeds);
    paint.paint(6, 6, 2.5, GRASS_BRUSHES.ferns);
    paint.paint(4, 4, 1.5, GRASS_BRUSHES.dry);
    const exclusions: GrassExclusion[] = [{ minX: 3, minZ: 3, maxX: 4.5, maxZ: 5 }];
    for (const quality of qualities) {
      expectSamePatch(generateCoreGrassPatch(0, 0, quality, exclusions, paint.patchDocument(0, 0)),
        generateGrassPatch(0, 0, quality, exclusions, paint));
    }
    paint.dispose();
  });
});
