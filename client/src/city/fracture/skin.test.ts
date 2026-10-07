import { describe, expect, it } from 'vitest';

import { assembleBroken, assembleContacts } from './assemble';
import { FaceKind } from './contacts';
import { triangulateConvex } from './delaunay2d';
import { interfacePoint } from './interface';
import { FRACTURE_LOOKS } from './looks';
import { dot, orient2, type Vec2, type Vec3 } from './math';
import type { PieceMesh } from './pieceSkin';
import { polytopeVolume } from './polytope';
import { buildSpecimen, SPECIMEN_KEYS, type SpecimenKey } from './specimens';

function signedVolume(mesh: PieceMesh, includeRebar = false): number {
  let v = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    if (!includeRebar && mesh.kinds[a] === FaceKind.Rebar) continue;
    const ax = p[a * 3]; const ay = p[a * 3 + 1]; const az = p[a * 3 + 2];
    const bx = p[b * 3]; const by = p[b * 3 + 1]; const bz = p[b * 3 + 2];
    const cx = p[c * 3]; const cy = p[c * 3 + 1]; const cz = p[c * 3 + 2];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

function build(key: SpecimenKey, density = 1) {
  const specimen = buildSpecimen(key);
  const table = assembleContacts(specimen.pieces);
  const built = assembleBroken(specimen.pieces, table, {
    broken: () => true, rough: true, rebar: true, density, looks: FRACTURE_LOOKS,
    families: specimen.rebar, seed: 1,
  });
  return { specimen, table, built };
}

describe('delaunay2d', () => {
  it('triangulates a convex polygon with edge samples and interior points, keeping the boundary', () => {
    const boundary: Vec2[] = [[0, 0], [0.5, 0], [1, 0], [1, 1], [0, 1]];
    const interior: Vec2[] = [[0.3, 0.3], [0.6, 0.4], [0.4, 0.7], [0.75, 0.75]];
    const { points, triangles } = triangulateConvex(boundary, interior);
    let area = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const o = orient2(points[triangles[i]], points[triangles[i + 1]], points[triangles[i + 2]]);
      expect(o).toBeGreaterThan(0);
      area += o / 2;
    }
    expect(area).toBeCloseTo(1, 9);
    // Every vertex used.
    expect(new Set(triangles).size).toBe(points.length);
  });
});

describe('crack interfaces', () => {
  it('keep jagged edges in the shared outer plane and pinned edges on the original edge', () => {
    const { specimen, built } = build('rc-wall');
    let jaggedPoints = 0;
    for (const iface of built.interfaces) {
      for (const edge of iface.edges) {
        for (const v of edge.indices) {
          for (const side of ['a', 'b'] as const) {
            const p = interfacePoint(iface, v, side);
            if (edge.jagged) {
              // Moved, but only within the outer face it borders.
              const m = edge.outer!;
              expect(Math.abs(dot(m, p) - dot(m, edge.from))).toBeLessThan(1e-9);
              jaggedPoints += 1;
            } else {
              // On the straight segment from -> to.
              const d: Vec3 = [edge.to[0] - edge.from[0], edge.to[1] - edge.from[1], edge.to[2] - edge.from[2]];
              const r: Vec3 = [p[0] - edge.from[0], p[1] - edge.from[1], p[2] - edge.from[2]];
              const t = dot(r, d) / dot(d, d);
              const off = Math.hypot(r[0] - d[0] * t, r[1] - d[1] * t, r[2] - d[2] * t);
              expect(off).toBeLessThan(1e-9);
            }
          }
        }
      }
    }
    expect(jaggedPoints).toBeGreaterThan(100);
    expect(specimen.pieces.length).toBeGreaterThan(10);
  });

  it('give both pieces one surface, offset only by the crack opening', () => {
    const { built } = build('rc-wall');
    const opening = FRACTURE_LOOKS[1].relief.crackOpening;
    for (const iface of built.interfaces) {
      for (let v = 0; v < iface.relief.length; v += 1) {
        const a = interfacePoint(iface, v, 'a');
        const b = interfacePoint(iface, v, 'b');
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThanOrEqual(2 * opening + 1e-12);
      }
    }
  });

  it('is deterministic', () => {
    const one = build('rc-wall').built.meshes;
    const two = build('rc-wall').built.meshes;
    expect(two.map((m) => m.positions)).toEqual(one.map((m) => m.positions));
  });
});

describe('piece skins', () => {
  for (const key of SPECIMEN_KEYS) {
    it(`${key}: every piece stays a closed, outward solid near its collider's volume`, () => {
      const { specimen, built } = build(key);
      specimen.pieces.forEach((piece, p) => {
        const mesh = built.meshes[p];
        for (const x of mesh.positions) expect(Number.isFinite(x)).toBe(true);
        const hull = polytopeVolume(piece.poly);
        const area = piece.poly.faces.reduce((s, f) => s + f.area, 0);
        const look = FRACTURE_LOOKS[piece.cls].relief;
        const slack = area * (look.amplitude * 2.5 + look.crackOpening) + hull * 0.02;
        expect(signedVolume(mesh)).toBeGreaterThan(0);
        expect(Math.abs(signedVolume(mesh) - hull), `${key} piece ${p}`).toBeLessThan(slack);
      });
    });
  }

  it('the RC wall grows rebar and the plain wall does not', () => {
    expect(build('rc-wall').built.stats.rebarStubs).toBeGreaterThan(20);
    expect(build('concrete-wall').built.stats.rebarStubs).toBe(0);
  });
});
