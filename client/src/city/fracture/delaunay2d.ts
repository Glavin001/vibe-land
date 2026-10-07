// Delaunay triangulation of a convex polygon plus interior points.
//
// Small and specialised: the boundary is a CCW convex polygon whose edges may
// carry collinear samples, and it must come out of the triangulation exactly
// as given (those samples are shared with the neighbouring face). Fan from the
// centroid, insert the interior points one at a time, and restore the Delaunay
// property with Lawson flips. Boundary edges have no twin, so they can never
// be flipped. Insertion order is the input order: deterministic.

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

  const centre = boundary.length;
  for (let i = 0; i < boundary.length; i += 1) add(centre, i, (i + 1) % boundary.length);

  let scale = 0;
  for (const p of boundary) scale = Math.max(scale, Math.abs(p[0] - centroid[0]), Math.abs(p[1] - centroid[1]));
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

  for (let p = centre + 1; p < n; p += 1) {
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
  return { points, triangles };
}
