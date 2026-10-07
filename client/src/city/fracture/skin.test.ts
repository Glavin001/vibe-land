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

function build(key: SpecimenKey, { density = 1, wear = false, broken = true } = {}) {
  const specimen = buildSpecimen(key);
  const table = assembleContacts(specimen.pieces);
  const built = assembleBroken(specimen.pieces, table, {
    broken: () => broken, rough: true, wear, rebar: true, density, looks: FRACTURE_LOOKS,
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
              // Moved within the outer face it borders, then sunk below it by
              // exactly its spall depth (never above it).
              const m = edge.outer!;
              expect(Math.abs(dot(m, p) - dot(m, edge.from) + iface.chipDepth[v])).toBeLessThan(1e-9);
              expect(iface.chipDepth[v]).toBeGreaterThanOrEqual(0);
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
      const { specimen, built } = build(key, { wear: true });
      specimen.pieces.forEach((piece, p) => {
        const mesh = built.meshes[p];
        for (const x of mesh.positions) expect(Number.isFinite(x)).toBe(true);
        const hull = polytopeVolume(piece.poly);
        const area = piece.poly.faces.reduce((s, f) => s + f.area, 0);
        const look = FRACTURE_LOOKS[piece.cls].relief;
        // The interface's own relief cap (brick steps up to half a brick).
        const reach = Math.max(look.amplitude * 2.5, look.courseHeight > 0 ? look.courseHeight * 1.6 : 0);
        const slack = area * (reach + look.crackOpening) + hull * 0.02;
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

describe('worn edges', () => {
  const worldOf = (mesh: PieceMesh, centroid: Vec3, i: number): Vec3 =>
    [mesh.positions[i * 3] + centroid[0], mesh.positions[i * 3 + 1] + centroid[1], mesh.positions[i * 3 + 2] + centroid[2]];

  it('round the original arrises of an intact wall, and only there', () => {
    const { specimen, built } = build('concrete-wall', { wear: true, broken: false });
    const radius = FRACTURE_LOOKS[0].wear.radius;
    let worn = 0;
    let deepest = 0;
    built.meshes.forEach((mesh) => {
      for (let i = 0; i < mesh.kinds.length; i += 1) {
        if (mesh.kinds[i] !== FaceKind.Exterior) continue;
        deepest = Math.max(deepest, mesh.relief[i]);
        if (mesh.relief[i] > 0.3) worn += 1;
      }
    });
    expect(worn).toBeGreaterThan(200);
    // Never deeper than the field's reach allows.
    const field = FRACTURE_LOOKS[0].wear;
    expect(deepest * radius).toBeLessThan(field.radius * (1 + field.variation) * (1 + field.chipDepth) * 1.5);
    expect(specimen.pieces.length).toBeGreaterThan(10);
  });

  it('keep every seam between two intact pieces watertight', () => {
    const { specimen, table, built } = build('concrete-wall', { wear: true, broken: false });
    let checked = 0;
    for (const contact of table.contacts) {
      const n = contact.normal;
      const w = dot(n, contact.polygon[0]);
      const onSeam = (p: number): Vec3[] => {
        const mesh = built.meshes[p];
        const out: Vec3[] = [];
        for (let i = 0; i < mesh.kinds.length; i += 1) {
          if (mesh.kinds[i] !== FaceKind.Exterior) continue;
          const x = worldOf(mesh, specimen.pieces[p].centroid, i);
          if (Math.abs(dot(n, x) - w) < 1e-6) out.push(x);
        }
        return out;
      };
      const a = onSeam(contact.a);
      const b = onSeam(contact.b);
      // Every outer-face vertex A has on the seam, B has too. (10 um: the
      // Voronoi cutter itself places a shared junction ~1e-6 apart per cell.)
      for (const x of a) {
        expect(b.some((y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 1e-5)).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
