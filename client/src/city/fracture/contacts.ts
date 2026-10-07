// Which faces of a fractured structure are CUT faces.
//
// A pre-fractured structure carries no record of which hull faces were the
// original surface and which the fracturer made. They can be recovered from
// the geometry alone: two pieces touch where a face of one and a face of the
// other point opposite ways, lie in one plane, and overlap. A face mostly
// covered by such contacts was cut; anything else is the outside.
//
// Bonds are NOT used for this. Packs built by proximity detection put a bond's
// centroid between bounding boxes and its normal along the centroid line, so
// only 546 of fractured-highrise-10f's 3,451 bonds even lie on a face plane;
// matching faces geometrically finds 3,449 of them.

import { anyBasis } from './polytope';
import { clipConvex2, dot, polygonArea2, type Vec2, type Vec3 } from './math';
import { isJointMaterial, sameFamily, type FractureClass } from './materialClass';
import type { Polytope } from './polytope';

export const enum FaceKind {
  Exterior = 0,
  Fracture = 1,
  Joint = 2,
  Rebar = 3,
  Splinter = 4,
}

export interface FracturePiece {
  /** Rest position of the piece's frame origin, in the structure frame. */
  centroid: Vec3;
  /** The piece in its own frame (rest orientation, centred on `centroid`). */
  poly: Polytope;
  material: string;
  cls: FractureClass;
  /** Long axis for wood (0 x, 1 y, 2 z); the grain runs along it. */
  grainAxis?: number;
}

export interface Contact {
  a: number;
  b: number;
  faceA: number;
  faceB: number;
  /** Outward normal of A's face (B's is its negation). */
  normal: Vec3;
  /** Shared region in the structure frame, CCW about `normal`. */
  polygon: Vec3[];
  area: number;
  /** Fraction of each face the contact covers. */
  coverA: number;
  coverB: number;
  /** A joint letting go (mortar, nails, a different member) rather than a break. */
  joint: boolean;
}

export interface ContactTable {
  contacts: Contact[];
  /** Per piece, per face: FaceKind. */
  faceKind: Uint8Array[];
  /** Per piece, per face: contact indices touching it. */
  faceContacts: number[][][];
  stats: { pairsTested: number; contacts: number; full: number };
}

export interface ContactOptions {
  /** Normals this close to opposite count (cos of the angle between n and -n'). */
  oppositeCos?: number;
  /** Plane separation tolerance, metres. */
  planeTol?: number;
  /** Fraction of a face that must be in contact for it to count as cut. */
  coverToCut?: number;
  /** Optional per-pair material from the pack's bonds, keyed by pairKey(a, b). */
  bondMaterial?: Map<number, string>;
}

export const pairKey = (a: number, b: number): number => (a < b ? a * 1_048_576 + b : b * 1_048_576 + a);

/** Contacts at least this full on BOTH faces get a rough interface. */
export const FULL_COVER = 0.9;

export function findContacts(pieces: readonly FracturePiece[], options: ContactOptions = {}): ContactTable {
  const oppositeCos = options.oppositeCos ?? 0.9995;
  const planeTol = options.planeTol ?? 2e-3;
  const coverToCut = options.coverToCut ?? 0.5;

  // World AABBs and a sweep along x.
  const boxes = pieces.map((piece) => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const v of piece.poly.verts) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], v[k] + piece.centroid[k]);
        max[k] = Math.max(max[k], v[k] + piece.centroid[k]);
      }
    }
    return { min, max };
  });
  const order = pieces.map((_, i) => i).sort((i, j) => boxes[i].min[0] - boxes[j].min[0]);
  const margin = planeTol * 2;

  const contacts: Contact[] = [];
  const faceCover = pieces.map((p) => new Float64Array(p.poly.faces.length));
  const faceContacts = pieces.map((p) => p.poly.faces.map(() => [] as number[]));
  let pairsTested = 0;

  for (let oi = 0; oi < order.length; oi += 1) {
    const a = order[oi];
    for (let oj = oi + 1; oj < order.length; oj += 1) {
      const b = order[oj];
      if (boxes[b].min[0] > boxes[a].max[0] + margin) break;
      if (boxes[b].min[1] > boxes[a].max[1] + margin || boxes[a].min[1] > boxes[b].max[1] + margin) continue;
      if (boxes[b].min[2] > boxes[a].max[2] + margin || boxes[a].min[2] > boxes[b].max[2] + margin) continue;
      pairsTested += 1;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const contact = bestContact(pieces[lo], pieces[hi], lo, hi, oppositeCos, planeTol);
      if (!contact) continue;
      const bond = options.bondMaterial?.get(pairKey(lo, hi));
      contact.joint = bond !== undefined
        ? isJointMaterial(bond)
        : isJointMaterial(pieces[lo].material) || isJointMaterial(pieces[hi].material)
          || !sameFamily(pieces[lo].cls, pieces[hi].cls);
      const index = contacts.length;
      contacts.push(contact);
      faceCover[lo][contact.faceA] += contact.coverA;
      faceCover[hi][contact.faceB] += contact.coverB;
      faceContacts[lo][contact.faceA].push(index);
      faceContacts[hi][contact.faceB].push(index);
    }
  }

  const faceKind = pieces.map((piece, p) => {
    const kinds = new Uint8Array(piece.poly.faces.length);
    for (let f = 0; f < kinds.length; f += 1) {
      if (faceCover[p][f] < coverToCut) continue;
      const fracture = faceContacts[p][f].some((c) => !contacts[c].joint);
      kinds[f] = fracture ? FaceKind.Fracture : FaceKind.Joint;
    }
    return kinds;
  });

  const full = contacts.filter((c) => c.coverA >= FULL_COVER && c.coverB >= FULL_COVER).length;
  return { contacts, faceKind, faceContacts, stats: { pairsTested, contacts: contacts.length, full } };
}

function bestContact(
  A: FracturePiece, B: FracturePiece, a: number, b: number, oppositeCos: number, planeTol: number,
): Contact | null {
  let best: Contact | null = null;
  for (let fa = 0; fa < A.poly.faces.length; fa += 1) {
    const faceA = A.poly.faces[fa];
    const nA = faceA.normal;
    const wA = faceA.d + dot(nA, A.centroid);
    for (let fb = 0; fb < B.poly.faces.length; fb += 1) {
      const faceB = B.poly.faces[fb];
      if (dot(nA, faceB.normal) > -oppositeCos) continue;
      const wB = faceB.d + dot(faceB.normal, B.centroid);
      if (Math.abs(wA + wB) > planeTol) continue;
      const { t, b: bt } = anyBasis(nA);
      const project = (v: Vec3, at: Vec3): Vec2 => {
        const x = v[0] + at[0];
        const y = v[1] + at[1];
        const z = v[2] + at[2];
        return [x * t[0] + y * t[1] + z * t[2], x * bt[0] + y * bt[1] + z * bt[2]];
      };
      const polyA = faceA.loop.map((i) => project(A.poly.verts[i], A.centroid));
      // B's loop is CCW about -nA, so clockwise in A's frame.
      const polyB = faceB.loop.map((i) => project(B.poly.verts[i], B.centroid)).reverse();
      const overlap = clipConvex2(polyA, polyB);
      if (overlap.length < 3) continue;
      const area = polygonArea2(overlap);
      if (area <= Math.min(faceA.area, faceB.area) * 1e-3) continue;
      if (best && area <= best.area) continue;
      // Lift back onto A's plane.
      const polygon = overlap.map(([u, v]): Vec3 => [
        t[0] * u + bt[0] * v + nA[0] * wA,
        t[1] * u + bt[1] * v + nA[1] * wA,
        t[2] * u + bt[2] * v + nA[2] * wA,
      ]);
      best = {
        a, b, faceA: fa, faceB: fb, normal: nA, polygon, area,
        coverA: Math.min(1, area / faceA.area),
        coverB: Math.min(1, area / faceB.area),
        joint: false,
      };
    }
  }
  return best;
}
