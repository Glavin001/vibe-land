// Delaunay refinement of planar triangulations, for crack faces and for the
// worn bands of outer faces.
//
// Small and specialised: the boundary must come out exactly as given (its
// samples are shared with the neighbouring face), so boundary edges -- edges
// with no twin -- are never flipped. Points are inserted one at a time and the
// Delaunay property restored with Lawson flips. Insertion order is the input
// order: deterministic.
//
// `triangulateConvex` starts from a fan over a convex polygon; `refine`
// starts from any valid triangulation (an earcut of a jagged, non-convex
// outline) and inserts points into it.

import { orient2, type Vec2 } from './math';

export interface Triangulation {
  /** boundary, then the centroid, then the interior points, in input order. */
  points: Vec2[];
  /** CCW index triples. */
  triangles: number[];
}

export function triangulateConvex(boundary: readonly Vec2[], interior: readonly Vec2[]): Triangulation {
  let cx = 0;
  let cy = 0;
  for (const p of boundary) {
    cx += p[0];
    cy += p[1];
  }
  const centroid: Vec2 = [cx / boundary.length, cy / boundary.length];
  const points: Vec2[] = [...boundary, centroid, ...interior];
  const centre = boundary.length;
  const fan: number[] = [];
  for (let i = 0; i < boundary.length; i += 1) fan.push(centre, i, (i + 1) % boundary.length);
  return { points, triangles: refine(points, fan, centre + 1) };
}

/**
 * Insert points[firstInsert..] into a CCW triangulation of points[0..firstInsert)
 * whose outer edges are the constraint. Points outside it are dropped.
 */
export function refine(points: readonly Vec2[], initial: readonly number[], firstInsert: number): number[] {
  const n = points.length;
  const key = (i: number, j: number): number => i * n + j;
  const tris: Array<[number, number, number]> = [];
  const alive: boolean[] = [];
  const edges = new Map<number, number>();

  const add = (a: number, b: number, c: number): number => {
    const t = tris.length;
    tris.push([a, b, c]);
    alive.push(true);
    edges.set(key(a, b), t);
    edges.set(key(b, c), t);
    edges.set(key(c, a), t);
    return t;
  };
  const remove = (t: number): void => {
    alive[t] = false;
    const [a, b, c] = tris[t];
    for (const k of [key(a, b), key(b, c), key(c, a)]) {
      if (edges.get(k) === t) edges.delete(k);
    }
  };
  const third = (t: number, a: number, b: number): number => {
    const [x, y, z] = tris[t];
    return x !== a && x !== b ? x : y !== a && y !== b ? y : z;
  };
  const inCircle = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): number => {
    const ax = a[0] - d[0];
    const ay = a[1] - d[1];
    const bx = b[0] - d[0];
    const by = b[1] - d[1];
    const cx2 = c[0] - d[0];
    const cy2 = c[1] - d[1];
    return (ax * ax + ay * ay) * (bx * cy2 - cx2 * by)
      - (bx * bx + by * by) * (ax * cy2 - cx2 * ay)
      + (cx2 * cx2 + cy2 * cy2) * (ax * by - bx * ay);
  };
  const legalize = (stack: Array<[number, number]>): void => {
    let guard = 0;
    while (stack.length > 0 && guard < 100_000) {
      guard += 1;
      const [a, b] = stack.pop()!;
      const t1 = edges.get(key(a, b));
      const t2 = edges.get(key(b, a));
      if (t1 === undefined || t2 === undefined) continue;
      const c = third(t1, a, b);
      const d = third(t2, b, a);
      if (inCircle(points[a], points[b], points[c], points[d]) <= 1e-18) continue;
      // The quad a, d, b, c must be strictly convex to flip.
      if (orient2(points[a], points[d], points[c]) <= 0 || orient2(points[d], points[b], points[c]) <= 0) continue;
      remove(t1);
      remove(t2);
      add(a, d, c);
      add(d, b, c);
      stack.push([a, d], [d, b]);
    }
  };

  for (let i = 0; i + 2 < initial.length; i += 3) add(initial[i], initial[i + 1], initial[i + 2]);

  let lo0 = Infinity;
  let lo1 = Infinity;
  let hi0 = -Infinity;
  let hi1 = -Infinity;
  for (let i = 0; i < firstInsert; i += 1) {
    lo0 = Math.min(lo0, points[i][0]);
    hi0 = Math.max(hi0, points[i][0]);
    lo1 = Math.min(lo1, points[i][1]);
    hi1 = Math.max(hi1, points[i][1]);
  }
  const scale = Math.max(hi0 - lo0, hi1 - lo1, 1e-9);
  const eps = scale * scale * 1e-12;

  // Point location: walk from the last triangle touched (the lattice arrives
  // in row order, so the next point is almost always a step or two away), and
  // fall back to a scan only if the walk leaves the polygon.
  let lastTri = 0;
  const contains = (t: number, q: Vec2): { inside: boolean; edge: [number, number] | null; exit: number } => {
    const [a, b, c] = tris[t];
    const o0 = orient2(points[a], points[b], q);
    const o1 = orient2(points[b], points[c], q);
    const o2 = orient2(points[c], points[a], q);
    if (o0 < -eps) return { inside: false, edge: null, exit: edges.get(key(b, a)) ?? -1 };
    if (o1 < -eps) return { inside: false, edge: null, exit: edges.get(key(c, b)) ?? -1 };
    if (o2 < -eps) return { inside: false, edge: null, exit: edges.get(key(a, c)) ?? -1 };
    const edge: [number, number] | null = Math.abs(o0) <= eps ? [a, b] : Math.abs(o1) <= eps ? [b, c]
      : Math.abs(o2) <= eps ? [c, a] : null;
    return { inside: true, edge, exit: -1 };
  };

  for (let p = firstInsert; p < n; p += 1) {
    const q = points[p];
    let located = -1;
    let onEdge: [number, number] | null = null;
    let t = alive[lastTri] ? lastTri : alive.lastIndexOf(true);
    for (let steps = 0; t >= 0 && steps < 4 * tris.length; steps += 1) {
      const hit = contains(t, q);
      if (hit.inside) {
        located = t;
        onEdge = hit.edge;
        break;
      }
      t = hit.exit;
    }
    for (let s = 0; s < tris.length && located < 0; s += 1) {
      if (!alive[s]) continue;
      const hit = contains(s, q);
      if (hit.inside) {
        located = s;
        onEdge = hit.edge;
      }
    }
    if (located < 0) continue; // outside the polygon: dropped
    if (onEdge) {
      const [a, b] = onEdge;
      const t2 = edges.get(key(b, a));
      const c = third(located, a, b);
      remove(located);
      add(a, p, c);
      add(p, b, c);
      const stack: Array<[number, number]> = [[b, c], [c, a]];
      if (t2 !== undefined) {
        const d = third(t2, b, a);
        remove(t2);
        add(b, p, d);
        add(p, a, d);
        stack.push([a, d], [d, b]);
      }
      legalize(stack);
    } else {
      const [a, b, c] = tris[located];
      remove(located);
      add(a, b, p);
      add(b, c, p);
      add(c, a, p);
      legalize([[a, b], [b, c], [c, a]]);
    }
    lastTri = tris.length - 1;
  }

  const triangles: number[] = [];
  tris.forEach((t, i) => {
    if (alive[i]) triangles.push(t[0], t[1], t[2]);
  });
  return triangles;
}
