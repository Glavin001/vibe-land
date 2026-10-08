// The scene-scale machinery's own invariants: the compact far tier, the
// detail pool's class parts, and the noise table the shaders sample.

import { describe, expect, it } from 'vitest';

import { FaceKind, type FracturePiece } from '../city/fracture/contacts';
import { FractureClass } from '../city/fracture/materialClass';
import { emptyMesh } from '../city/fracture/pieceSkin';
import { polytopeFromBox } from '../city/fracture/polytope';
import { buildCompactGeometry, labGroups } from './labMesh';
import { NOISE_PERIOD, NOISE_TEXELS, fractureNoiseTexture } from './noiseTexture';
import { SkinPool } from './skinPool';

function boxPiece(cls: FractureClass, at: [number, number, number]): FracturePiece {
  return { centroid: at, poly: polytopeFromBox([0.5, 0.25, 0.1]), material: 'm', cls };
}

describe('compact far tier', () => {
  it('shares an outer box\'s corners: 8 vertices, 12 triangles, one group', () => {
    const piece = boxPiece(FractureClass.Concrete, [0, 0, 0]);
    const kinds = new Uint8Array(piece.poly.faces.length).fill(FaceKind.Exterior);
    const geometry = buildCompactGeometry([piece], [kinds]);
    expect(geometry.getAttribute('position').count).toBe(8);
    expect(geometry.index!.count).toBe(36);
    expect(labGroups(geometry)).toEqual([{ cls: FractureClass.Concrete, cut: false }]);
  });

  it('gives cut faces their own corners and their own group, and the groups cover every triangle', () => {
    const a = boxPiece(FractureClass.Concrete, [0, 0, 0]);
    const b = boxPiece(FractureClass.Brick, [2, 0, 0]);
    const kindsA = new Uint8Array(a.poly.faces.length).fill(FaceKind.Exterior);
    kindsA[0] = FaceKind.Fracture;
    const kindsB = new Uint8Array(b.poly.faces.length).fill(FaceKind.Exterior);
    kindsB[1] = FaceKind.Joint;
    const geometry = buildCompactGeometry([a, b], [kindsA, kindsB]);
    // Each box: 8 shared corners plus 4 for its one cut face.
    expect(geometry.getAttribute('position').count).toBe(24);
    const groups = geometry.groups;
    expect(labGroups(geometry)).toEqual([
      { cls: FractureClass.Concrete, cut: false },
      { cls: FractureClass.Concrete, cut: true },
      { cls: FractureClass.Brick, cut: false },
      { cls: FractureClass.Brick, cut: true },
    ]);
    expect(groups.map((g) => g.count)).toEqual([30, 6, 30, 6]);
    let at = 0;
    for (const g of groups) {
      expect(g.start).toBe(at);
      at += g.count;
    }
    expect(at).toBe(geometry.index!.count);
    // The packed code decodes back to (kind, class): kind + 8 grain + 64 class + 1024 side.
    const code = geometry.getAttribute('labCode');
    const index = geometry.index!;
    for (const [gi, g] of groups.entries()) {
      const { cls, cut } = labGroups(geometry)[gi];
      for (let k = g.start; k < g.start + g.count; k += 1) {
        const c = code.getX(index.getX(k));
        const side = Math.floor(c / 1024);
        const kc = c - side * 1024;
        expect(Math.floor(kc / 64)).toBe(cls);
        expect((kc % 64) % 8 > 0).toBe(cut);
      }
    }
  });
});

describe('detail pool parts', () => {
  const mesh = (triangles: number) => {
    const m = emptyMesh();
    for (let t = 0; t < triangles; t += 1) {
      for (let k = 0; k < 3; k += 1) {
        m.positions.push(t * 0.01, k * 0.01, 0);
        m.normals.push(0, 0, 1);
        m.kinds.push(FaceKind.Exterior);
        m.relief.push(0);
        m.sides.push(1);
        m.indices.push(t * 3 + k);
      }
    }
    return m;
  };
  const look = { layerCode: 0 };

  it('keeps one index buffer per class over shared vertices', () => {
    const pool = new SkinPool(10_000, 200_000, new Map([[FractureClass.Brick, 3], [FractureClass.Wood, 1]]));
    expect(pool.write(0, boxPiece(FractureClass.Brick, [0, 0, 0]), mesh(10), look)).toBe(true);
    expect(pool.write(1, boxPiece(FractureClass.Wood, [0, 0, 0]), mesh(5), look)).toBe(true);
    expect(pool.parts.map((p) => p.cls).sort()).toEqual([FractureClass.Brick, FractureClass.Wood]);
    const brick = pool.parts.find((p) => p.cls === FractureClass.Brick)!.geometry;
    const wood = pool.parts.find((p) => p.cls === FractureClass.Wood)!.geometry;
    expect(brick.getAttribute('position')).toBe(wood.getAttribute('position'));
    expect(brick.drawRange.count).toBe(30);
    expect(wood.drawRange.count).toBe(15);
    // Wood's indices point past brick's vertices, into the shared buffer.
    expect(wood.index!.getX(0)).toBe(30);
    pool.free(0);
    expect(brick.drawRange.count).toBe(0);
    expect(pool.verticesUsed).toBe(15);
  });

  it('grows a class\'s index buffer when the scene needs more of it', () => {
    const pool = new SkinPool(100_000, 1000, new Map([[FractureClass.Concrete, 1]]));
    const before = pool.write(0, boxPiece(FractureClass.Concrete, [0, 0, 0]), mesh(20_000), look);
    expect(before).toBe(true);
    // 65,536 indices to start with; 60,000 + 60,000 needs a second buffer.
    expect(pool.write(1, boxPiece(FractureClass.Concrete, [0, 0, 0]), mesh(20_000), look)).toBe(true);
    const geometry = pool.parts[0].geometry;
    expect(geometry.index!.count).toBeGreaterThanOrEqual(120_000);
    expect(geometry.drawRange.count).toBe(120_000);
    // Piece 0's indices survived the copy.
    expect(geometry.index!.getX(59_999)).toBe(59_999);
    expect(geometry.index!.getX(60_000)).toBe(60_000);
  });
});

describe('noise table', () => {
  const texture = fractureNoiseTexture();
  const data = texture.image.data as Uint8Array;
  const per = NOISE_TEXELS / NOISE_PERIOD;
  const texel = (x: number, y: number, z: number) => ((z * NOISE_TEXELS + y) * NOISE_TEXELS + x) * 4;

  it('holds the lattice hash at lattice points, with zero gradient there', () => {
    // frHash (fractureNodes.ts) at (3, 5, 7), in double precision.
    const fract = (v: number) => v - Math.floor(v);
    const q = [fract(3 * 0.1031), fract(5 * 0.1030), fract(7 * 0.0973)];
    const d = q[0] * (q[1] + 33.33) + q[1] * (q[2] + 33.33) + q[2] * (q[0] + 33.33);
    const hash = fract((q[0] + d + q[1] + d) * (q[2] + d));
    const o = texel(3 * per, 5 * per, 7 * per);
    expect(Math.abs(data[o] - hash * 255)).toBeLessThanOrEqual(0.5);
    for (let k = 1; k < 4; k += 1) expect(Math.abs(data[o + k] - 127.5)).toBeLessThanOrEqual(0.5);
  });

  it('tiles: the last texel blends back into the first lattice point', () => {
    // Value noise along x through texel rows: the step from the last texel
    // to the first must be as small as any interior step.
    let worst = 0;
    for (let x = 0; x < NOISE_TEXELS; x += 1) {
      const a = data[texel(x, 9, 13)];
      const b = data[texel((x + 1) % NOISE_TEXELS, 9, 13)];
      worst = Math.max(worst, Math.abs(a - b));
    }
    const wrap = Math.abs(data[texel(NOISE_TEXELS - 1, 9, 13)] - data[texel(0, 9, 13)]);
    expect(wrap).toBeLessThanOrEqual(worst);
    expect(worst).toBeLessThan(255 * 0.5);
  });
});
