// Relief of a crack surface, per material, as a height along the canonical
// crack normal at a rest-space point.
//
// Both pieces of a crack read the same field (see canonical.ts), so whatever
// shape this returns, one side gets it and the other gets its negative: the
// pieces still fit together like the real halves would.

import { fbm3, worley3 } from './hash';
import { dot, type Vec3 } from './math';
import { FractureClass } from './materialClass';
import type { ReliefLook } from './looks';

export function reliefHeight(
  p: Vec3, nc: Vec3, cls: FractureClass, look: ReliefLook, grain: Vec3 | null, seed: number,
  /** A point on the crack (its centroid): which joint each course snaps to. */
  anchor: Vec3 = p,
): number {
  switch (cls) {
    case FractureClass.Wood:
      return grain ? woodRelief(p, nc, look, grain, seed) : concreteRelief(p, look, seed);
    case FractureClass.Brick:
    case FractureClass.Mortar:
      return brickRelief(p, nc, look, seed, anchor);
    default:
      return concreteRelief(p, look, seed);
  }
}

/**
 * Concrete, stone, gypsum: broad lumps with sharp conchoidal crests where the
 * crack front changed direction, plus a finer octave of grit.
 */
function concreteRelief(p: Vec3, look: ReliefLook, seed: number): number {
  const f = 1 / look.featureSize;
  const broad = fbm3(p[0] * f, p[1] * f, p[2] * f, seed, 3);
  const g = f * 1.7;
  const crest = 1 - 2 * Math.abs(fbm3(p[0] * g + 17.1, p[1] * g, p[2] * g - 5.3, seed + 7, 3));
  const fine = fbm3(p[0] * f * 4, p[1] * f * 4, p[2] * f * 4, seed + 13, 2);
  const shape = broad * (1 - look.ridge) + crest * 0.6 * look.ridge + fine * 0.3 * look.detail;
  return look.amplitude * shape;
}

/**
 * Wood breaking across the grain: fibres pull out in bundles, so the surface
 * is a field of long splinters running ALONG the grain -- tall where a bundle
 * pulled out of this side, sockets where it pulled out of the other. Cells are
 * stretched along the grain; height is how far along the grain the bundle tore.
 */
function woodRelief(p: Vec3, nc: Vec3, look: ReliefLook, grain: Vec3, seed: number): number {
  const along = dot(p, grain);
  // Fibre-bundle cells: small across the grain, long along it.
  const f = 1 / look.featureSize;
  const q: Vec3 = [
    (p[0] - grain[0] * along) * f + grain[0] * along * f / look.grainStretch,
    (p[1] - grain[1] * along) * f + grain[1] * along * f / look.grainStretch,
    (p[2] - grain[2] * along) * f + grain[2] * along * f / look.grainStretch,
  ];
  const cell = worley3(q[0], q[1], q[2], seed);
  // Which side the bundle pulled from, and how far it tore: mostly short,
  // a few long slivers (a heavy tail, as torn timber has).
  const sign = (cell.id & 1) === 0 ? 1 : -1;
  const u = ((cell.id >>> 8) & 0xff) / 255;
  const reach = 0.15 + 0.85 * u * u * u;
  // Sharp splinter: a needle at the bundle's middle, falling off to its edge.
  const edge = Math.max(0, 1 - cell.f1 / Math.max(1e-6, cell.f2));
  const spike = Math.pow(edge, 1.6);
  // End grain (crack across the fibres) splinters; side grain barely does.
  const endGrain = Math.abs(dot(nc, grain));
  const fine = fbm3(q[0] * 3, q[1] * 3, q[2] * 3, seed + 3, 2);
  return look.amplitude * (look.splinter * endGrain * sign * reach * spike + 0.15 * fine);
}

/**
 * Masonry fails along its mortar. A crack through running-bond brickwork
 * steps: up a head joint, along a bed joint, up the next head joint half a
 * brick over. So each course's slice of a vertical crack SNAPS to the head
 * joint nearest the crack in that course, and a horizontal crack to the
 * nearest bed joint. The bond grid is the skin's (fractureNodes.ts
 * skinSurface): courses of `courseHeight`, bricks three courses long, odd
 * courses offset half a brick, along the horizontal axis the crack faces.
 */
function brickRelief(p: Vec3, nc: Vec3, look: ReliefLook, seed: number, anchor: Vec3): number {
  const f = 1 / look.featureSize;
  const grit = fbm3(p[0] * f, p[1] * f, p[2] * f, seed, 2) * look.amplitude;
  const course = look.courseHeight;
  if (course <= 0) return grit;
  const len = course * 3;
  // The horizontal axis the crack faces along: the wall's length.
  const alongX = Math.abs(nc[0]) >= Math.abs(nc[2]);
  const nu = alongX ? nc[0] : nc[2];
  const u = alongX ? p[0] : p[2];
  const ua = alongX ? anchor[0] : anchor[2];
  if (Math.abs(nu) > 0.35 && Math.abs(nc[1]) < 0.7) {
    const k = Math.floor(p[1] / course);
    const offset = (k & 1) === 1 ? len / 2 : 0;
    const joint = Math.round((ua + offset) / len) * len - offset;
    return (joint - u) / nu + grit;
  }
  if (Math.abs(nc[1]) >= 0.7) {
    const joint = Math.round(anchor[1] / course) * course;
    return (joint - p[1]) / nc[1] + grit;
  }
  return grit;
}
