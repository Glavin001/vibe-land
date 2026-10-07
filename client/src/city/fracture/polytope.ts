// A piece's shape as planar POLYGON faces, not a triangle soup.
//
// The manifest gives a hull as an unordered point cloud and the renderer has
// always re-hulled it into triangles (chunkGeometry.ts). Fracture surfaces need
// more: which triangles form one flat face (a Voronoi cut is one face, however
// QuickHull split it), the face's outline in order, and which face lies across
// each edge. That is a polytope: unique vertices, faces as CCW vertex loops
// seen from outside, and a directed-edge map so the neighbour across any edge
// is one lookup.
//
// Coordinates are the piece's own frame (centroid-relative, rest orientation),
// the same frame the manifest's hull points and the slot mesh use.

import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { Vector3 } from 'three';

import { add, cross, dot, normalize, sub, type Vec2, type Vec3 } from './math';

export interface PolyFace {
  /** Outward unit normal. */
  normal: Vec3;
  /** Plane offset: normal · x = d for points on the face. */
  d: number;
  /** Vertex indices, CCW seen from outside (right-handed about `normal`). */
  loop: number[];
  area: number;
  centroid: Vec3;
}

export interface Polytope {
  verts: Vec3[];
  faces: PolyFace[];
  /** Directed edge "i>j" -> the face whose loop walks i then j. */
  edgeFace: Map<number, number>;
  /** False when some edge has no twin; the solid is still drawable, flat. */
  closed: boolean;
}

/** Key for the directed edge i -> j. Hulls are far below 65,536 vertices. */
export const edgeKey = (i: number, j: number): number => i * 65_536 + j;

/** The face across edge (i, j) of a face that walks i -> j, or -1. */
export function faceAcross(poly: Polytope, i: number, j: number): number {
  return poly.edgeFace.get(edgeKey(j, i)) ?? -1;
}

/** Normal agreement for two triangles to count as one face (~0.57 degrees). */
const COPLANAR_COS = 0.99995;

/**
 * Build a polytope from a hull point cloud (any order, duplicates allowed).
 * Returns null when the points enclose no volume.
 */
export function polytopeFromPoints(points: ArrayLike<number>): Polytope | null {
  // Weld duplicates first: packs repeat every prism vertex three times.
  const unique: Vec3[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i + 2 < points.length; i += 3) {
    const key = `${Math.round(points[i] * 1e5)},${Math.round(points[i + 1] * 1e5)},${Math.round(points[i + 2] * 1e5)}`;
    if (seen.has(key)) continue;
    seen.set(key, unique.length);
    unique.push([points[i], points[i + 1], points[i + 2]]);
  }
  if (unique.length < 4) return null;

  const vectors = unique.map((p) => new Vector3(p[0], p[1], p[2]));
  const indexOf = new Map<Vector3, number>();
  vectors.forEach((v, i) => indexOf.set(v, i));
  const hull = new ConvexHull().setFromPoints(vectors);
  if (hull.faces.length < 4) return null;

  let extent = 0;
  for (const p of unique) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const planeTol = Math.max(5e-5, extent * 2e-5);

  // Cluster hull triangles into planes.
  const planes: Array<{ n: Vec3; d: number; verts: Set<number> }> = [];
  for (const face of hull.faces) {
    const n: Vec3 = [face.normal.x, face.normal.y, face.normal.z];
    const d = face.constant;
    let plane = planes.find((p) => dot(p.n, n) > COPLANAR_COS && Math.abs(p.d - d) < planeTol);
    if (!plane) {
      plane = { n, d, verts: new Set() };
      planes.push(plane);
    }
    let edge = face.edge;
    do {
      const index = indexOf.get(edge.head().point);
      if (index !== undefined) plane.verts.add(index);
      edge = edge.next;
    } while (edge !== face.edge);
  }

  // Every hull vertex on a plane belongs to that face, including ones a
  // neighbouring triangle cluster contributed.
  const faces: PolyFace[] = [];
  for (const plane of planes) {
    for (let i = 0; i < unique.length; i += 1) {
      if (Math.abs(dot(plane.n, unique[i]) - plane.d) < planeTol) plane.verts.add(i);
    }
    const loop = convexLoop(unique, [...plane.verts], plane.n);
    if (loop.length < 3) continue;
    faces.push(makeFace(unique, loop, plane.n));
  }
  return finish(unique, faces);
}

/** An axis-aligned box of the given half extents, centred on the origin. */
export function polytopeFromBox(half: Vec3): Polytope {
  const [x, y, z] = half;
  const verts: Vec3[] = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const loops: Array<[number[], Vec3]> = [
    [[1, 2, 6, 5], [1, 0, 0]],
    [[0, 4, 7, 3], [-1, 0, 0]],
    [[3, 7, 6, 2], [0, 1, 0]],
    [[0, 1, 5, 4], [0, -1, 0]],
    [[4, 5, 6, 7], [0, 0, 1]],
    [[0, 3, 2, 1], [0, 0, -1]],
  ];
  return finish(verts, loops.map(([loop, n]) => makeFace(verts, loop, n)));
}

function makeFace(verts: Vec3[], loop: number[], n: Vec3): PolyFace {
  // Area and centroid by fanning from the first vertex.
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const o = verts[loop[0]];
  for (let i = 1; i + 1 < loop.length; i += 1) {
    const a = verts[loop[i]];
    const b = verts[loop[i + 1]];
    const tri = dot(cross(sub(a, o), sub(b, o)), n) / 2;
    area += tri;
    cx += tri * (o[0] + a[0] + b[0]) / 3;
    cy += tri * (o[1] + a[1] + b[1]) / 3;
    cz += tri * (o[2] + a[2] + b[2]) / 3;
  }
  const centroid: Vec3 = area > 0 ? [cx / area, cy / area, cz / area] : o;
  return { normal: n, d: dot(n, centroid), loop, area, centroid };
}

function finish(verts: Vec3[], faces: PolyFace[]): Polytope {
  const edgeFace = new Map<number, number>();
  faces.forEach((face, f) => {
    for (let i = 0; i < face.loop.length; i += 1) {
      edgeFace.set(edgeKey(face.loop[i], face.loop[(i + 1) % face.loop.length]), f);
    }
  });
  let closed = true;
  for (const key of edgeFace.keys()) {
    const i = Math.floor(key / 65_536);
    const j = key % 65_536;
    if (!edgeFace.has(edgeKey(j, i))) {
      closed = false;
      break;
    }
  }
  return { verts, faces, edgeFace, closed };
}

/** An in-plane basis for normal n (any; used only to sort a loop). */
export function anyBasis(n: Vec3): { t: Vec3; b: Vec3 } {
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const t = normalize(cross(helper, n));
  return { t, b: cross(n, t) };
}

/**
 * The CCW (about n) convex outline of coplanar vertices, collinear points
 * dropped: monotone chain in the plane's 2D frame.
 */
function convexLoop(verts: Vec3[], indices: number[], n: Vec3): number[] {
  const { t, b } = anyBasis(n);
  const pts = indices.map((i) => ({ i, p: [dot(verts[i], t), dot(verts[i], b)] as Vec2 }));
  pts.sort((u, v) => (u.p[0] - v.p[0]) || (u.p[1] - v.p[1]));
  let extent = 0;
  for (const { p } of pts) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  const eps = Math.max(1e-12, extent * extent * 1e-9);
  const turn = (o: Vec2, a: Vec2, c: Vec2): number => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: typeof pts = [];
  for (const q of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2].p, lower[lower.length - 1].p, q.p) <= eps) lower.pop();
    lower.push(q);
  }
  const upper: typeof pts = [];
  for (let k = pts.length - 1; k >= 0; k -= 1) {
    const q = pts[k];
    while (upper.length >= 2 && turn(upper[upper.length - 2].p, upper[upper.length - 1].p, q.p) <= eps) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  // (t, b, n) is right-handed, so CCW in (t, b) is CCW about n.
  return [...lower, ...upper].map((q) => q.i);
}

/** Enclosed volume (divergence theorem over the faces). */
export function polytopeVolume(poly: Polytope): number {
  let v = 0;
  for (const face of poly.faces) v += face.area * face.d;
  return v / 3;
}

export function polytopeArea(poly: Polytope): number {
  return poly.faces.reduce((s, f) => s + f.area, 0);
}

/** Axis-aligned bounds of the vertices, offset by `at`. */
export function polytopeBounds(poly: Polytope, at: Vec3 = [0, 0, 0]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of poly.verts) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], v[k] + at[k]);
      max[k] = Math.max(max[k], v[k] + at[k]);
    }
  }
  return { min, max };
}

/** Depth of the solid behind a face: max distance of any vertex below its plane. */
export function depthBehind(poly: Polytope, f: number): number {
  const face = poly.faces[f];
  let depth = 0;
  for (const v of poly.verts) depth = Math.max(depth, face.d - dot(face.normal, v));
  return depth;
}

/** The same solid moved by `by` (synthetic specimens build pieces off-centre). */
export function translatePolytope(poly: Polytope, by: Vec3): Polytope {
  const verts = poly.verts.map((v) => add(v, by));
  const faces = poly.faces.map((f) => ({ ...f, d: f.d + dot(f.normal, by), centroid: add(f.centroid, by) }));
  return { verts, faces, edgeFace: poly.edgeFace, closed: poly.closed };
}
