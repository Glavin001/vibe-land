// Where the lab puts each piece: exploded views for studying the breaks, and
// a "blast" that throws them so you can watch them fly. Neither is physics;
// both are deterministic from a seed, so two variants side by side move
// identically and a still can be retaken.

import type { Contact } from '../city/fracture/contacts';
import { hash01 } from '../city/fracture/hash';
import { add, cross, dot, normalize, scale, sub, type Vec3 } from '../city/fracture/math';
import type { Specimen } from '../city/fracture/specimens';

export type ExplodeMode = 'radial' | 'crack' | 'book' | 'blast';

export interface Pose {
  p: Vec3;
  q: [number, number, number, number];
}

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

export function axisAngle(axis: Vec3, angle: number): [number, number, number, number] {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

export function rotateByQuat(q: readonly number[], v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

export function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Which side of the split plane a piece sits on. */
export function splitSide(specimen: Specimen, piece: number): 1 | -1 {
  const c = specimen.pieces[piece].centroid;
  return dot(sub(c, specimen.impact), specimen.splitNormal) >= 0 ? 1 : -1;
}

/** Contacts that let go in a mode: all of them, or only those across the split. */
export function brokenInMode(specimen: Specimen, contacts: readonly Contact[], mode: ExplodeMode): (ci: number) => boolean {
  if (mode === 'radial' || mode === 'blast') return () => true;
  return (ci) => splitSide(specimen, contacts[ci].a) !== splitSide(specimen, contacts[ci].b);
}

/** The side the camera looks from: the specimen's thinnest axis, toward +. */
function viewNormal(specimen: Specimen): Vec3 {
  const size = sub(specimen.max, specimen.min);
  const axis = size[0] < size[1] && size[0] < size[2] ? 0 : size[2] <= size[1] ? 2 : 1;
  const v: Vec3 = [0, 0, 0];
  v[axis] = 1;
  // A horizontal slab is looked at from above.
  return axis === 1 ? [0, 1, 0] : v;
}

/**
 * Static exploded layouts, `amount` 0 (assembled) .. 1 (fully opened).
 *   radial  every piece moves out from the impact, gaps growing with distance
 *   crack   the two halves slide apart along the split normal
 *   book    one half swings open 90 degrees on a hinge at the back face, so
 *           both faces of each crack along the split face the camera
 */
export function explodedPose(
  specimen: Specimen, piece: number, mode: ExplodeMode, amount: number, spin: number, seed: number,
): Pose {
  const c = specimen.pieces[piece].centroid;
  if (amount <= 0) return { p: c, q: IDENTITY };
  const r = (k: number): number => hash01(seed, piece, k);
  const tumble = (scaleAngle: number): [number, number, number, number] =>
    axisAngle([r(1) - 0.5, r(2) - 0.5, r(3) - 0.5], (r(4) - 0.5) * 2 * scaleAngle * spin * amount);

  if (mode === 'radial' || mode === 'blast') {
    const view = viewNormal(specimen);
    const away = sub(c, specimen.impact);
    // Classic exploded view: scale about the impact, plus a push toward the
    // viewer so cut faces turn to the camera.
    const push = add(scale(away, 0.9 * amount), scale(view, amount * (0.15 + 0.5 * r(5))));
    return { p: add(c, push), q: tumble(Math.PI * 0.5) };
  }

  const side = splitSide(specimen, piece);
  if (mode === 'crack') {
    const gap = scale(specimen.splitNormal, side * amount * 0.6);
    return { p: add(c, gap), q: tumble(Math.PI * 0.06) };
  }

  // Book: hinge the + half about a line in the split plane, at the back face.
  if (side < 0) return { p: c, q: IDENTITY };
  const view = viewNormal(specimen);
  const back = Math.min(dot(specimen.min, view), dot(specimen.max, view));
  const hingePoint = add(sub(specimen.impact, scale(view, dot(specimen.impact, view) - back)),
    scale(specimen.splitNormal, 0.02));
  const axis = normalize(cross(scale(specimen.splitNormal, -1), view));
  const q = axisAngle(axis, (Math.PI / 2) * amount);
  const p = add(hingePoint, rotateByQuat(q, sub(c, hingePoint)));
  return { p: add(p, scale(specimen.splitNormal, 0.08 * amount)), q };
}

interface BlastBody {
  p: Vec3;
  v: Vec3;
  q: [number, number, number, number];
  w: Vec3;
  /** Piece-local vertices, for the floor contact. */
  verts: Vec3[];
  resting: boolean;
}

/**
 * A blast: pieces thrown from the impact with speed falling off with
 * distance, tumbling, under gravity, bouncing off a floor at y = 0. Not
 * physics -- no piece-piece contact -- just enough to watch them fly.
 */
export class Blast {
  private readonly bodies: BlastBody[];
  time = 0;

  constructor(private readonly specimen: Specimen, seed: number, strength: number) {
    const view = viewNormal(specimen);
    this.bodies = specimen.pieces.map((piece, i) => {
      const r = (k: number): number => hash01(seed, i, 100 + k);
      const away = sub(piece.centroid, specimen.impact);
      const dist = Math.hypot(away[0], away[1], away[2]);
      const dir = normalize(add(add(normalize(away), scale(view, 0.9)), [0, 0.35, 0]));
      const speed = strength * (0.35 + 1.2 / (0.6 + dist)) * (0.7 + 0.6 * r(1));
      const jitter: Vec3 = [(r(2) - 0.5) * 0.6, (r(3) - 0.5) * 0.6, (r(4) - 0.5) * 0.6];
      const v = add(scale(dir, speed), scale(jitter, strength * 0.3));
      const w: Vec3 = [(r(5) - 0.5) * 14, (r(6) - 0.5) * 14, (r(7) - 0.5) * 14];
      return { p: piece.centroid, v, q: [0, 0, 0, 1], w: scale(w, 0.3 + 0.7 * Math.min(1, speed / strength)), verts: piece.poly.verts, resting: false };
    });
  }

  /** Advance by dt seconds (fixed sub-steps for stability). */
  step(dt: number): void {
    const sub_ = 1 / 240;
    let left = dt;
    while (left > 1e-9) {
      const h = Math.min(sub_, left);
      left -= h;
      this.time += h;
      for (const body of this.bodies) {
        if (body.resting) continue;
        body.v = [body.v[0], body.v[1] - 9.81 * h, body.v[2]];
        body.p = add(body.p, scale(body.v, h));
        const speed = Math.hypot(body.w[0], body.w[1], body.w[2]);
        if (speed > 1e-6) body.q = normalizeQ(quatMul(axisAngle(body.w, speed * h), body.q));
        // Floor contact at the lowest posed vertex.
        let lowest = Infinity;
        for (const v of body.verts) lowest = Math.min(lowest, rotateByQuat(body.q, v)[1] + body.p[1]);
        if (lowest < 0) {
          body.p = [body.p[0], body.p[1] - lowest, body.p[2]];
          if (body.v[1] < 0) body.v = [body.v[0] * 0.55, -body.v[1] * 0.25, body.v[2] * 0.55];
          body.w = scale(body.w, 0.7);
          if (Math.hypot(body.v[0], body.v[1], body.v[2]) < 0.15) body.resting = true;
        }
      }
    }
  }

  pose(piece: number): Pose {
    const body = this.bodies[piece];
    return { p: body.p, q: body.q };
  }

  get settled(): boolean {
    return this.bodies.every((b) => b.resting);
  }

  get pieces(): number {
    return this.specimen.pieces.length;
  }
}

function normalizeQ(q: [number, number, number, number]): [number, number, number, number] {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
