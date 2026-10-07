// The canonical crack frame: how both pieces of one crack agree on "up".
//
// Piece A sees the crack face with outward normal n, piece B with -n. Every
// relief and pattern is a function of the absolute rest-space position, and
// displacement is taken along a CANONICAL normal -- n flipped into a fixed
// hemisphere -- so A and B compute the same surface: a ridge on one is the
// matching valley on the other. The GPU shading uses the same two directions
// (fractureNodes.ts), so the shaded relief and the geometric relief agree.

import { cross, dot, normalize, type Vec3 } from './math';

/** A direction no authored face is ever parallel or perpendicular to. */
export const G: Vec3 = normalize([0.5773, 0.6123, 0.5401]);
/** A second generic direction, for the in-plane basis. */
export const G2: Vec3 = normalize([0.2357, -0.4714, 0.8498]);

/** +1 or -1: which way n must flip to land in the canonical hemisphere. */
export function canonicalSign(n: Vec3): 1 | -1 {
  const d = dot(n, G);
  if (Math.abs(d) > 1e-9) return d > 0 ? 1 : -1;
  return dot(n, G2) >= 0 ? 1 : -1;
}

export function canonicalNormal(n: Vec3): Vec3 {
  const s = canonicalSign(n);
  return [n[0] * s, n[1] * s, n[2] * s];
}

/**
 * An orthonormal in-plane basis (t, b) for a plane with canonical normal nc.
 * Absolute: it depends only on nc, so both pieces lay the same lattice.
 */
export function planeBasis(nc: Vec3): { t: Vec3; b: Vec3 } {
  let t = cross(nc, G2);
  if (Math.hypot(t[0], t[1], t[2]) < 1e-6) t = cross(nc, G);
  t = normalize(t);
  const b = normalize(cross(nc, t));
  return { t, b };
}
