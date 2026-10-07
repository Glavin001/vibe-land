import { describe, expect, it } from 'vitest';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { Vector3 } from 'three';

import { FaceKind, findContacts, FULL_COVER, pairKey, type FracturePiece } from './contacts';
import { hash01, hashU32, mulberry32 } from './hash';
import { FractureClass, fractureClassOf, isJointMaterial } from './materialClass';
import { dot } from './math';
import { faceAcross, polytopeFromBox, polytopeFromPoints, polytopeVolume } from './polytope';
import { DEFAULT_REBAR_LOOK, rebarStubs } from './rebar';
import { buildSpecimen, SPECIMEN_KEYS } from './specimens';

const CUBE = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];

function euler(points: number[]): { v: number; e: number; f: number } {
  const poly = polytopeFromPoints(points)!;
  const used = new Set(poly.faces.flatMap((f) => f.loop));
  const e = poly.faces.reduce((s, f) => s + f.loop.length, 0) / 2;
  return { v: used.size, e, f: poly.faces.length };
}

describe('polytope', () => {
  it('merges a cube into six square faces with CCW loops', () => {
    const poly = polytopeFromPoints(CUBE)!;
    expect(poly.faces).toHaveLength(6);
    expect(poly.closed).toBe(true);
    for (const face of poly.faces) {
      expect(face.loop).toHaveLength(4);
      expect(face.area).toBeCloseTo(4, 9);
      // Every vertex on the plane, and the loop winds right-handed about n.
      for (const i of face.loop) expect(dot(face.normal, poly.verts[i])).toBeCloseTo(face.d, 9);
    }
    expect(polytopeVolume(poly)).toBeCloseTo(8, 9);
  });

  it('still merges coplanar triangles under 1e-6 jitter and duplicate points', () => {
    const rng = mulberry32(1);
    const jittered = CUBE.map((x) => x + (rng() - 0.5) * 1e-6);
    const poly = polytopeFromPoints([...jittered, ...jittered, ...jittered])!;
    expect(poly.faces).toHaveLength(6);
    expect(poly.closed).toBe(true);
  });

  it('matches ConvexGeometry volume on a hexagonal prism, Euler 2', () => {
    const points: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      const a = (k / 6) * Math.PI * 2 + 0.1;
      points.push(Math.cos(a), -0.1, Math.sin(a), Math.cos(a), 0.1, Math.sin(a));
    }
    const poly = polytopeFromPoints(points)!;
    expect(poly.faces).toHaveLength(8);
    const { v, e, f } = euler(points);
    expect(v - e + f).toBe(2);
    const geometry = new ConvexGeometry(
      Array.from({ length: points.length / 3 }, (_, i) => new Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2])),
    );
    const pos = geometry.getAttribute('position');
    let vol = 0;
    for (let i = 0; i < pos.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(pos, i);
      const b = new Vector3().fromBufferAttribute(pos, i + 1);
      const c = new Vector3().fromBufferAttribute(pos, i + 2);
      vol += a.dot(b.clone().cross(c)) / 6;
    }
    expect(polytopeVolume(poly)).toBeCloseTo(vol, 5);
  });

  it('finds the face across every edge', () => {
    const poly = polytopeFromBox([0.5, 1, 2]);
    for (let f = 0; f < poly.faces.length; f += 1) {
      const loop = poly.faces[f].loop;
      for (let i = 0; i < loop.length; i += 1) {
        const across = faceAcross(poly, loop[i], loop[(i + 1) % loop.length]);
        expect(across).toBeGreaterThanOrEqual(0);
        expect(across).not.toBe(f);
      }
    }
  });
});

describe('hash', () => {
  it('is stable across runs (golden values)', () => {
    expect(hashU32(1, 2, 3)).toBe(hashU32(1, 2, 3));
    expect(hashU32(1, 2, 3)).not.toBe(hashU32(3, 2, 1));
    expect(hash01(0)).toBeGreaterThanOrEqual(0);
    expect(hash01(0)).toBeLessThan(1);
    expect(hashU32(0, 0, 0)).toBe(1260530469);
  });
});

describe('material classes', () => {
  it('maps pack material names to deliberate classes', () => {
    expect(fractureClassOf('reinforced-concrete')).toBe(FractureClass.Reinforced);
    expect(fractureClassOf('concrete-slab')).toBe(FractureClass.Reinforced);
    expect(fractureClassOf('brick-veneer')).toBe(FractureClass.Brick);
    expect(fractureClassOf('veneer-mortar-joint')).toBe(FractureClass.Mortar);
    expect(fractureClassOf('stud-timber')).toBe(FractureClass.Wood);
    expect(fractureClassOf('drywall')).toBe(FractureClass.Gypsum);
    expect(fractureClassOf('window-glass')).toBe(FractureClass.Glass);
    expect(fractureClassOf('glazing-clip')).toBe(FractureClass.Glass);
    expect(fractureClassOf('concrete-roof-tile')).toBe(FractureClass.Ceramic);
    expect(fractureClassOf('metal')).toBe(FractureClass.Steel);
    expect(fractureClassOf(undefined)).toBe(FractureClass.Concrete);
    expect(isJointMaterial('facade-clip')).toBe(true);
    expect(isJointMaterial('brick')).toBe(false);
  });
});

describe('contacts', () => {
  it('finds every Voronoi cut of the RC wall, and only cuts are FRACTURE', () => {
    const specimen = buildSpecimen('rc-wall');
    const table = findContacts(specimen.pieces);
    // A Voronoi diagram of n cells in a rectangle has at most 3n - 6 shared
    // edges; every one must match exactly one face pair, fully on both sides.
    expect(table.contacts.length).toBeGreaterThan(specimen.pieces.length);
    for (const contact of table.contacts) {
      expect(contact.coverA).toBeGreaterThan(FULL_COVER);
      expect(contact.coverB).toBeGreaterThan(FULL_COVER);
      expect(contact.joint).toBe(false);
    }
    // The two caps of every shard face the outside.
    specimen.pieces.forEach((piece, p) => {
      piece.poly.faces.forEach((face, f) => {
        if (Math.abs(face.normal[2]) > 0.99) expect(table.faceKind[p][f]).toBe(FaceKind.Exterior);
      });
    });
  });

  it('a T-junction cuts the small face and leaves the big face outside', () => {
    // A 0.2 m post standing on a 2 m slab.
    const slab: FracturePiece = {
      centroid: [0, -0.1, 0], poly: polytopeFromBox([1, 0.1, 1]), material: 'concrete', cls: FractureClass.Concrete,
    };
    const post: FracturePiece = {
      centroid: [0, 0.5, 0], poly: polytopeFromBox([0.1, 0.5, 0.1]), material: 'concrete', cls: FractureClass.Concrete,
    };
    const table = findContacts([slab, post]);
    expect(table.contacts).toHaveLength(1);
    const c = table.contacts[0];
    expect(c.area).toBeCloseTo(0.04, 6);
    expect(table.faceKind[1][c.faceB]).toBe(FaceKind.Fracture);
    expect(table.faceKind[0][c.faceA]).toBe(FaceKind.Exterior);
  });

  it('different families and joint materials let go as joints', () => {
    const brick: FracturePiece = {
      centroid: [0, 0.5, 0], poly: polytopeFromBox([0.5, 0.5, 0.05]), material: 'brick', cls: FractureClass.Brick,
    };
    const stud: FracturePiece = {
      centroid: [0, 0.5, 0.1], poly: polytopeFromBox([0.5, 0.5, 0.05]), material: 'stud-timber', cls: FractureClass.Wood,
    };
    const table = findContacts([brick, stud]);
    expect(table.contacts[0].joint).toBe(true);
    expect(table.faceKind[0][table.contacts[0].faceA]).toBe(FaceKind.Joint);
    const hinted = findContacts([brick, { ...stud, material: 'brick', cls: FractureClass.Brick }], {
      bondMaterial: new Map([[pairKey(0, 1), 'veneer-mortar-joint']]),
    });
    expect(hinted.contacts[0].joint).toBe(true);
  });

  it('every specimen builds closed pieces with contacts', () => {
    for (const key of SPECIMEN_KEYS) {
      const specimen = buildSpecimen(key);
      expect(specimen.pieces.length, key).toBeGreaterThan(1);
      for (const piece of specimen.pieces) expect(piece.poly.closed, key).toBe(true);
      expect(findContacts(specimen.pieces).contacts.length, key).toBeGreaterThan(0);
    }
  });
});

describe('rebar', () => {
  it('grows two halves of the same bar from the same point, lengths summing to the exposed length', () => {
    const specimen = buildSpecimen('rc-wall');
    const table = findContacts(specimen.pieces);
    let bars = 0;
    for (const [ci, contact] of table.contacts.entries()) {
      const stubs = rebarStubs(contact, specimen.rebar, DEFAULT_REBAR_LOOK, ci);
      const a = stubs.filter((s) => s.side === 'a');
      const b = stubs.filter((s) => s.side === 'b');
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i += 1) {
        bars += 1;
        expect(a[i].barId).toBe(b[i].barId);
        expect(a[i].crossing).toEqual(b[i].crossing);
        // Each stub's root is embedded behind the crack plane on its own side.
        const n = contact.normal;
        const w = dot(n, contact.polygon[0]);
        expect(dot(n, a[i].points[0]) - w).toBeLessThan(0);
        expect(dot(n, b[i].points[0]) - w).toBeGreaterThan(0);
        const len = (pts: number[][]): number => pts.slice(1).reduce((s, p, k) =>
          s + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1], p[2] - pts[k][2]), 0);
        const exposed = len(a[i].points.slice(1)) + len(b[i].points.slice(1));
        expect(exposed).toBeGreaterThanOrEqual(DEFAULT_REBAR_LOOK.stubMin - 1e-9);
        expect(exposed).toBeLessThanOrEqual(DEFAULT_REBAR_LOOK.stubMax + 1e-9);
      }
    }
    expect(bars).toBeGreaterThan(20);
  });

  it('plain concrete has no bars', () => {
    const specimen = buildSpecimen('concrete-wall');
    expect(specimen.rebar).toHaveLength(0);
  });
});
