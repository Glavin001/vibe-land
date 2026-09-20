import { describe, expect, it } from 'vitest';

import { atlasCell, atlasIndex, atlasLayout, atlasPixel } from './fluidAtlas';

describe('fluid atlas layout', () => {
  it('tiles the slices as squarely as the count allows', () => {
    expect(atlasLayout(48, 36, 48)).toMatchObject({ tilesX: 8, tilesY: 6, width: 384, height: 216 });
    expect(atlasLayout(64, 48, 64)).toMatchObject({ tilesX: 8, tilesY: 8, width: 512, height: 384 });
    expect(atlasLayout(8, 8, 6)).toMatchObject({ tilesX: 3, tilesY: 2 });
  });

  it('round-trips every cell through its pixel', () => {
    const layout = atlasLayout(6, 5, 12);
    const seen = new Set<number>();
    for (let z = 0; z < layout.nz; z += 1) {
      for (let y = 0; y < layout.ny; y += 1) {
        for (let x = 0; x < layout.nx; x += 1) {
          const [px, py] = atlasPixel(layout, x, y, z);
          expect(px).toBeLessThan(layout.width);
          expect(py).toBeLessThan(layout.height);
          expect(atlasCell(layout, px, py)).toEqual([x, y, z]);
          const index = atlasIndex(layout, x, y, z);
          expect(seen.has(index)).toBe(false);
          seen.add(index);
        }
      }
    }
    expect(seen.size).toBe(layout.width * layout.height);
  });

  it('puts neighbouring slices in neighbouring tiles', () => {
    const layout = atlasLayout(4, 4, 8);
    expect(atlasPixel(layout, 0, 0, 0)).toEqual([0, 0]);
    expect(atlasPixel(layout, 0, 0, 1)).toEqual([4, 0]);
    expect(atlasPixel(layout, 0, 0, layout.tilesX)).toEqual([0, 4]);
  });
});
