// Worn edges: no real wall, slab or stud has the knife-sharp edges of its
// collision box. Cast concrete arrises are rounded and chipped, brick arrises
// are knocked, timber is eased. This rounds and chips a piece's ORIGINAL
// edges -- where two outer faces meet -- whether or not it ever breaks.
//
// The rounded surface is the zero set of a smooth maximum (log-sum-exp) of
// the piece's outer planes in rest space:
//
//   F(x) = k(x) log sum_i exp((n_i . x - w_i) / k(x))
//
// F is 0 on a face far from any edge and positive near an edge, so pushing
// each surface vertex down F's gradient until F = 0 rounds exactly the edges
// and nothing else. The radius varies along the edge with rest-space noise,
// and an occasional cell takes a much bigger bite: a chip.
//
// Two pieces of one wall share its outer planes, and F is a pure function of
// rest-space position, so at a seam between them both round the edge the same
// way and the outer surface stays continuous. Vertices that sit on a cut or a
// joint face are only allowed to slide WITHIN that face (or along the line of
// two), so the seam faces still close the solid.

import { fbm3, worley3 } from './hash';
import type { CrackInterface } from './interface';
import { dot, normalize, scale, sub, type Vec3 } from './math';

export interface WearLook {
  /** Typical rounding radius of an outer edge, metres (0 disables). */
  radius: number;
  /** 0..1: how much the radius wanders along the edge. */
  variation: number;
  /** 0..1: share of chip cells along an edge that are chipped. */
  chips: number;
  /** Chip size, metres. */
  chipSize: number;
  /** How much bigger a chip's bite is than the plain rounding. */
  chipDepth: number;
}

export interface WearPlane {
  n: Vec3;
  /** n . x = w on the face, structure frame. */
  w: number;
}

/** LSE's rounding radius is about 2.4 k for a right-angled edge. */
const K_PER_RADIUS = 1 / 2.4;

export class WearField {
  constructor(
    readonly planes: readonly WearPlane[],
    readonly look: WearLook,
    readonly seed: number,
  ) {}

  /** The widest the rounding can reach, for tessellation bands. */
  get reach(): number {
    return this.look.radius * (1 + this.look.variation) * (1 + this.look.chipDepth) * 1.35;
  }

  /** Local smoothing scale at x. */
  k(x: Vec3): number {
    const { radius, variation, chips, chipSize, chipDepth } = this.look;
    const s = 1 / Math.max(1e-4, radius * 5);
    const wander = 1 + variation * fbm3(x[0] * s, x[1] * s, x[2] * s, this.seed + 71, 2) * 1.6;
    let bite = 1;
    if (chips > 0 && chipSize > 0) {
      const c = 1 / chipSize;
      const cell = worley3(x[0] * c, x[1] * c, x[2] * c, this.seed + 73);
      if (((cell.id >>> 4) & 0xff) / 255 < chips) {
        const blob = 1 - Math.min(1, Math.max(0, (cell.f1 - 0.15) / 0.5));
        bite += chipDepth * blob * blob * (3 - 2 * blob);
      }
    }
    return Math.max(1e-5, radius * K_PER_RADIUS * Math.max(0.2, wander) * bite);
  }

  /** F and its gradient (k held constant across the gradient). */
  value(x: Vec3): { f: number; g: Vec3 } {
    const k = this.k(x);
    let m = -Infinity;
    for (const p of this.planes) m = Math.max(m, dot(p.n, x) - p.w);
    let sum = 0;
    const g: Vec3 = [0, 0, 0];
    for (const p of this.planes) {
      const a = dot(p.n, x) - p.w - m;
      if (a < -12 * k) continue;
      const e = Math.exp(a / k);
      sum += e;
      g[0] += p.n[0] * e;
      g[1] += p.n[1] * e;
      g[2] += p.n[2] * e;
    }
    return { f: m + k * Math.log(sum), g: scale(g, 1 / sum) };
  }

  /**
   * Move a surface point onto the worn surface, sliding only within the given
   * constraint planes (unit normals). Returns the point, how far it moved and
   * the worn surface's normal there.
   */
  project(x0: Vec3, constraints: readonly Vec3[] = []): { x: Vec3; depth: number; normal: Vec3 } {
    let x = x0;
    let g: Vec3 = [0, 0, 0];
    const basis = orthonormal(constraints);
    for (let it = 0; it < 8; it += 1) {
      const v = this.value(x);
      g = v.g;
      if (v.f < 1e-7) break;
      let d = g;
      for (const c of basis) d = sub(d, scale(c, dot(d, c)));
      const dd = dot(d, d);
      if (dd < 1e-6) break;
      // Newton along the allowed direction, damped against overshoot.
      const step = Math.min(v.f / dd, this.reach * 2);
      x = sub(x, scale(d, step));
    }
    const depth = Math.hypot(x[0] - x0[0], x[1] - x0[1], x[2] - x0[2]);
    return { x, depth, normal: normalize(g) };
  }
}

/** Gram-Schmidt; drops near-duplicate constraint normals. */
function orthonormal(vectors: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of vectors) {
    let u = v;
    for (const b of out) u = sub(u, scale(b, dot(u, b)));
    const l = Math.hypot(u[0], u[1], u[2]);
    if (l > 1e-4) out.push(scale(u, 1 / l));
    if (out.length === 3) break;
  }
  return out;
}

/** A piece's outer planes in the structure frame, deduplicated (LSE counts a twice-listed plane twice). */
export function outerPlanes(planes: ReadonlyArray<{ n: Vec3; w: number }>): WearPlane[] {
  const out: WearPlane[] = [];
  for (const p of planes) {
    if (out.some((q) => dot(q.n, p.n) > 0.9999 && Math.abs(q.w - p.w) < 1e-4)) continue;
    out.push({ n: p.n, w: p.w });
  }
  return out;
}

/**
 * Wear a crack surface where it runs into a worn arris, once for both pieces.
 * Interior and jagged-edge vertices slide in the crack's own tangent plane;
 * pinned-edge vertices stay on both the crack plane and the face across the
 * edge, exactly as that face's own vertices are constrained.
 */
export function wearInterface(iface: CrackInterface, field: WearField): void {
  const count = iface.relief.length;
  const pinnedNormals = new Map<number, Vec3[]>();
  for (const edge of iface.edges) {
    if (edge.jagged || !edge.acrossA) continue;
    for (const v of edge.indices) {
      const list = pinnedNormals.get(v) ?? [iface.normal];
      list.push(edge.acrossA);
      pinnedNormals.set(v, list);
    }
  }
  for (let v = 0; v < count; v += 1) {
    const x: Vec3 = [iface.base[v * 3], iface.base[v * 3 + 1], iface.base[v * 3 + 2]];
    if (field.value(x).f < 1e-7) continue;
    const n: Vec3 = [iface.normals[v * 3], iface.normals[v * 3 + 1], iface.normals[v * 3 + 2]];
    const out = field.project(x, pinnedNormals.get(v) ?? [n]);
    iface.base[v * 3] = out.x[0];
    iface.base[v * 3 + 1] = out.x[1];
    iface.base[v * 3 + 2] = out.x[2];
  }
}
