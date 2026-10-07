// Reinforcement: where the bars are, and what sticks out when concrete breaks.
//
// A reinforced member's steel is laid out as FAMILIES of parallel bars on a
// rest-space grid -- a wall's two mats are four families (horizontal and
// vertical bars at each face), a column's corner bars are two. Because the
// grid is absolute, every piece of the member agrees on where every bar runs:
// the GPU draws a bar's rusty cross-section exactly where the CPU grows its
// stub, and both pieces of one crack grow halves of the SAME bar, from the same
// point, with lengths that add up to the bar's exposed length.

import { hash01, hashU32 } from './hash';
import { add, addScaled, cross, dot, insideConvex2, normalize, scale, sub, type Vec2, type Vec3 } from './math';
import { planeBasis } from './canonical';
import type { Contact } from './contacts';

export interface RebarFamily {
  /** Bar direction (unit). */
  dir: Vec3;
  /** Spacing direction (unit, perpendicular to dir). */
  across: Vec3;
  spacing: number;
  /** Offset of bar 0 along `across`. */
  phase: number;
  /** Mat-depth direction (unit, perpendicular to both). */
  depthAxis: Vec3;
  /** Mat position along `depthAxis`. */
  depth: number;
  radius: number;
}

export interface RebarLook {
  /** Exposed length of a snapped bar (both stubs together), metres. */
  stubMin: number;
  stubMax: number;
  /** Largest bend over a stub's length, degrees. */
  bendDeg: number;
  /** How far a stub starts inside its piece, so its root is never seen. */
  embed: number;
  /** Tube resolution. */
  sides: number;
  segments: number;
}

export const DEFAULT_REBAR_LOOK: RebarLook = {
  stubMin: 0.06,
  stubMax: 0.42,
  bendDeg: 38,
  embed: 0.03,
  sides: 6,
  segments: 5,
};

export interface RebarStub {
  /** Which side of the contact: the stub belongs to contact.a or contact.b. */
  side: 'a' | 'b';
  /** Centreline, structure frame, root (embedded) first. */
  points: Vec3[];
  radius: number;
  barId: number;
  /** Where the bar crossed the crack plane, for tests and debug. */
  crossing: Vec3;
}

/**
 * The bars crossing a broken contact, as a stub on each side.
 * Bars nearly parallel to the crack plane are skipped: they run along the
 * break rather than through it.
 */
export function rebarStubs(
  contact: Contact,
  families: readonly RebarFamily[],
  look: RebarLook,
  contactKey: number,
): RebarStub[] {
  const n = contact.normal;
  const w = dot(n, contact.polygon[0]);
  const { t, b } = planeBasis(n);
  const poly2: Vec2[] = contact.polygon.map((p) => [dot(p, t), dot(p, b)]);
  // planeBasis(n) may be left- or right-handed about n relative to the
  // polygon's CCW order; insideConvex2 wants CCW.
  if (signedArea(poly2) < 0) poly2.reverse();
  const stubs: RebarStub[] = [];

  families.forEach((family, fi) => {
    const along = dot(family.dir, n);
    if (Math.abs(along) < 0.3) return;
    // Range of bar indices whose lines can pass through the polygon.
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of contact.polygon) {
      // Position along `across` of the bar line through p (moving along dir).
      const s = dot(p, family.across) - dot(family.dir, family.across) * dot(p, family.dir);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    const k0 = Math.ceil((lo - family.phase) / family.spacing - 1e-9);
    const k1 = Math.floor((hi - family.phase) / family.spacing + 1e-9);
    const dA = along > 0 ? family.dir : scale(family.dir, -1);
    for (let k = k0; k <= k1; k += 1) {
      const base = add(scale(family.depthAxis, family.depth), scale(family.across, family.phase + k * family.spacing));
      const tHit = (w - dot(n, base)) / dot(n, family.dir);
      const crossing = addScaled(base, family.dir, tHit);
      if (!insideConvex2([dot(crossing, t), dot(crossing, b)], poly2, family.radius * 1.5)) continue;
      const barId = hashU32(fi, k, Math.round(family.depth * 1000));
      const total = look.stubMin + (look.stubMax - look.stubMin) * hash01(barId, contactKey, 1);
      const split = 0.2 + 0.6 * hash01(barId, contactKey, 2);
      stubs.push(bentStub('a', crossing, dA, total * split, family.radius, barId, contactKey, look));
      stubs.push(bentStub('b', crossing, scale(dA, -1), total * (1 - split), family.radius, barId, contactKey, look));
    }
  });
  return stubs;
}

function signedArea(poly: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return s / 2;
}

/**
 * A stub leaving its piece along `out` from the crack point: a straight root
 * embedded in the concrete, then bending progressively (yielded steel bends
 * most at its free end), about an axis hashed per bar and side.
 */
function bentStub(
  side: 'a' | 'b', crossing: Vec3, out: Vec3, length: number, radius: number,
  barId: number, contactKey: number, look: RebarLook,
): RebarStub {
  const sideSeed = side === 'a' ? 11 : 13;
  // A bend axis perpendicular to the bar.
  const angle = hash01(barId, contactKey, sideSeed) * Math.PI * 2;
  const helper: Vec3 = Math.abs(out[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(out, helper));
  const v = cross(out, u);
  const axis = normalize(add(scale(u, Math.cos(angle)), scale(v, Math.sin(angle))));
  const bend = (look.bendDeg * Math.PI / 180) * (0.25 + 0.75 * hash01(barId, contactKey, sideSeed + 1));

  const points: Vec3[] = [addScaled(crossing, out, -look.embed), crossing];
  let dir = out;
  let at = crossing;
  const segments = Math.max(1, look.segments);
  for (let s = 1; s <= segments; s += 1) {
    const f = s / segments;
    dir = rotate(out, axis, bend * f * f);
    at = addScaled(at, dir, length / segments);
    points.push(at);
  }
  return { side, points, radius, barId, crossing };
}

/** Rodrigues rotation of v about unit axis k by angle a. */
function rotate(v: Vec3, k: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const kd = dot(k, v);
  return [
    v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
    v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
    v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
  ];
}

export interface TubeMesh {
  positions: number[];
  normals: number[];
  /** Distance along the bar from its root, per vertex (the shader's ribs). */
  along: number[];
  indices: number[];
}

/**
 * A ribbed-looking tube along a polyline: `sides` vertices per ring, the tip
 * necked to 70 % (a bar that yielded before it snapped) and closed by a cone.
 * Positions are written relative to `origin` (the owning piece's centroid).
 */
export function appendTube(out: TubeMesh, points: readonly Vec3[], radius: number, sides: number, origin: Vec3): void {
  const base = out.positions.length / 3;
  const rings = points.length;
  let prevU: Vec3 | null = null;
  let travelled = 0;
  for (let r = 0; r < rings; r += 1) {
    const p = points[r];
    if (r > 0) travelled += Math.hypot(p[0] - points[r - 1][0], p[1] - points[r - 1][1], p[2] - points[r - 1][2]);
    const tangent = normalize(r === 0 ? sub(points[1], points[0])
      : r === rings - 1 ? sub(points[r], points[r - 1])
        : sub(points[r + 1], points[r - 1]));
    // Parallel-transport-ish frame: keep u close to the previous ring's.
    let u: Vec3 = prevU ?? (Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    u = normalize(sub(u, scale(tangent, dot(u, tangent))));
    const v = cross(tangent, u);
    prevU = u;
    const neck = r === rings - 1 ? 0.7 : 1;
    for (let s = 0; s < sides; s += 1) {
      const a = (s / sides) * Math.PI * 2;
      const nrm = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      const pos = addScaled(p, nrm, radius * neck);
      out.positions.push(pos[0] - origin[0], pos[1] - origin[1], pos[2] - origin[2]);
      out.normals.push(nrm[0], nrm[1], nrm[2]);
      out.along.push(travelled);
    }
  }
  for (let r = 0; r + 1 < rings; r += 1) {
    for (let s = 0; s < sides; s += 1) {
      const a = base + r * sides + s;
      const b = base + r * sides + ((s + 1) % sides);
      const c = base + (r + 1) * sides + s;
      const d = base + (r + 1) * sides + ((s + 1) % sides);
      out.indices.push(a, b, d, a, d, c);
    }
  }
  // Tip: a snapped end, necked and nearly flat (a cup, not a point).
  const last = points[rings - 1];
  const dirTip = normalize(sub(last, points[rings - 2]));
  const tip = addScaled(last, dirTip, radius * 0.18);
  const tipIndex = out.positions.length / 3;
  out.positions.push(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
  out.normals.push(dirTip[0], dirTip[1], dirTip[2]);
  out.along.push(travelled);
  const ring = base + (rings - 1) * sides;
  for (let s = 0; s < sides; s += 1) {
    out.indices.push(ring + s, ring + ((s + 1) % sides), tipIndex);
  }
}
