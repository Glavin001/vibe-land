// Small vector helpers for the fracture-surface modules.
//
// Kept free of three.js, like city/vec.ts, so the geometry core runs in plain
// vitest and can move into a worker or the native app unchanged. Everything is
// in double precision; only the final mesh buffers are Float32.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a: Vec3, b: Vec3, u: number): Vec3 => [
  a[0] + (b[0] - a[0]) * u,
  a[1] + (b[1] - a[1]) * u,
  a[2] + (b[2] - a[2]) * u,
];

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Twice the signed area of the 2D triangle (a, b, c); positive when CCW. */
export const orient2 = (a: Vec2, b: Vec2, c: Vec2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Signed area of a 2D polygon; positive when CCW. */
export function polygonArea2(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return s / 2;
}

/** Distance from p to the segment ab, in 2D. */
export function segmentDistance2(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t));
}

/**
 * Clip a convex CCW polygon by another convex CCW polygon (Sutherland-Hodgman).
 * Returns the CCW intersection, empty when they do not overlap.
 */
export function clipConvex2(subject: readonly Vec2[], clipper: readonly Vec2[]): Vec2[] {
  let output: Vec2[] = subject.slice();
  for (let i = 0; i < clipper.length && output.length > 0; i += 1) {
    const a = clipper[i];
    const b = clipper[(i + 1) % clipper.length];
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k += 1) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      const dp = orient2(a, b, p);
      const dq = orient2(a, b, q);
      if (dp >= 0) output.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq);
        output.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return output;
}

/** Point-in-convex-CCW-polygon, with an inward margin (positive shrinks it). */
export function insideConvex2(p: Vec2, poly: readonly Vec2[], margin = 0): boolean {
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    if (orient2(a, b, p) / len < margin) return false;
  }
  return true;
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
