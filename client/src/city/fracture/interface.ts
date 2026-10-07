// The rough surface of one broken contact, shared by both pieces.
//
// Built ONCE per contact and handed to both pieces -- A draws it as is, B
// draws it mirrored -- so the two halves of a crack fit by construction, not
// by two computations agreeing to the last bit.
//
// Edge rules (all decided from the two pieces' face tables, so either piece
// would decide the same):
//   - An edge where the crack meets the OUTSIDE on both pieces, in one shared
//     outer plane, is JAGGED: its points move within that plane, so the outer
//     faces stay flat while their outline goes ragged.
//   - Every other edge (meeting another cut, or a joint) is PINNED: zero
//     displacement, so the neighbouring cut faces still close the solid.
//   - Relief fades to zero over `taper` from pinned edges and is clamped to a
//     fraction of either piece's depth, so it never pokes out the far side.

import { canonicalNormal, planeBasis } from './canonical';
import { FaceKind, type Contact, type FracturePiece } from './contacts';
import { triangulateConvex } from './delaunay2d';
import { fbm3, hash01, hashU32 } from './hash';
import { reliefHeight } from './heightFields';
import type { ReliefLook } from './looks';
import {
  add, clamp, cross, dot, insideConvex2, normalize, polygonArea2, scale, segmentDistance2, smoothstep, sub,
  type Vec2, type Vec3,
} from './math';
import { depthBehind, faceAcross } from './polytope';

export interface InterfaceEdge {
  /** Vertex indices along the edge, from polygon corner k to corner k+1. */
  indices: number[];
  jagged: boolean;
  /** Normal of the outer plane a jagged edge moves within. */
  outer: Vec3 | null;
  /** In the outer plane, pointing from the crack into piece A (B: negate). */
  inwardA: Vec3;
  /** World endpoints (undisplaced), for matching the edge from a face loop. */
  from: Vec3;
  to: Vec3;
}

export interface CrackInterface {
  contact: number;
  a: number;
  b: number;
  faceA: number;
  faceB: number;
  /** A's outward normal across the crack. */
  normal: Vec3;
  /** Displaced shared surface, structure frame. */
  base: Float64Array;
  /** Piece A's recession from the shared surface (B uses the negative). */
  off: Float64Array;
  /** A-side normals (B's are negated). */
  normals: Float32Array;
  /** Relief / amplitude per vertex: the shader darkens valleys with it. */
  relief: Float32Array;
  /**
   * Spalling along jagged edges: how far each edge vertex was pushed below
   * the outer face, and how far back into the face the chip reaches. Zero
   * off the jagged edges. The pieces' outer faces bevel down to it.
   */
  chipDepth: Float32Array;
  chipWidth: Float32Array;
  /** CCW about A's outward normal. */
  triangles: Uint32Array;
  edges: InterfaceEdge[];
}

export interface InterfaceInput {
  contact: Contact;
  contactIndex: number;
  pieces: readonly FracturePiece[];
  faceKind: readonly Uint8Array[];
  look: ReliefLook;
  /** Multiplies lattice density (LOD); 1 = the look's own spacing. */
  density: number;
  seed: number;
}

/** World position of piece p's vertex i. */
const world = (piece: FracturePiece, i: number): Vec3 => add(piece.poly.verts[i], piece.centroid);

function findVertex(piece: FracturePiece, loop: readonly number[], at: Vec3, tol: number): number {
  for (const i of loop) {
    const w = world(piece, i);
    if (Math.abs(w[0] - at[0]) < tol && Math.abs(w[1] - at[1]) < tol && Math.abs(w[2] - at[2]) < tol) return i;
  }
  return -1;
}

/**
 * Build the crack surface for a contact that fully covers both faces (the
 * polygon is then A's face itself). Returns null for partial contacts, which
 * keep their flat face.
 */
export function buildInterface(input: InterfaceInput): CrackInterface | null {
  const { contact, pieces, faceKind, look } = input;
  const A = pieces[contact.a];
  const B = pieces[contact.b];
  const faceA = A.poly.faces[contact.faceA];
  const faceB = B.poly.faces[contact.faceB];
  const nA = faceA.normal;
  const loopA = faceA.loop;
  const corners = loopA.map((i) => world(A, i));
  const tol = 2e-3;

  // --- Classify the polygon's edges -------------------------------------
  const pinned: boolean[] = [];
  const outer: Array<Vec3 | null> = [];
  for (let k = 0; k < loopA.length; k += 1) {
    const i = loopA[k];
    const j = loopA[(k + 1) % loopA.length];
    const adjA = faceAcross(A.poly, i, j);
    // B walks this edge the other way round its own face.
    const ib = findVertex(B, faceB.loop, corners[k], tol);
    const jb = findVertex(B, faceB.loop, corners[(k + 1) % loopA.length], tol);
    const adjB = ib >= 0 && jb >= 0 ? faceAcross(B.poly, jb, ib) : -1;
    let jagged = false;
    if (adjA >= 0 && adjB >= 0
      && faceKind[contact.a][adjA] === FaceKind.Exterior && faceKind[contact.b][adjB] === FaceKind.Exterior) {
      const mA = A.poly.faces[adjA].normal;
      const mB = B.poly.faces[adjB].normal;
      const wA = A.poly.faces[adjA].d + dot(mA, A.centroid);
      const wB = B.poly.faces[adjB].d + dot(mB, B.centroid);
      jagged = dot(mA, mB) > 0.9995 && Math.abs(wA - wB) < tol;
    }
    pinned.push(!jagged);
    outer.push(jagged ? A.poly.faces[adjA].normal : null);
  }

  // --- 2D frame: absolute, so the lattice is anchored in rest space -------
  const nc = canonicalNormal(nA);
  const { t, b } = planeBasis(nc);
  const w0 = dot(corners[0], nc);
  let flip = 1;
  const to2 = (p: Vec3): Vec2 => [dot(p, t), dot(p, b) * flip];
  if (polygonArea2(corners.map(to2)) < 0) flip = -1;
  const poly2 = corners.map(to2);
  const from2 = (q: Vec2): Vec3 => add(add(scale(t, q[0]), scale(b, q[1] * flip)), scale(nc, w0));

  // Clamp relief by both pieces' depth behind the crack.
  const depth = Math.min(depthBehind(A.poly, contact.faceA), depthBehind(B.poly, contact.faceB));
  const hMax = Math.min(look.amplitude * 2.5, depth * look.maxDepthFraction);

  // Lattice spacing, coarsened to respect the vertex cap.
  let a = Math.max(1e-3, look.lattice / Math.max(0.1, input.density));
  const area = Math.abs(polygonArea2(poly2));
  let perimeter = 0;
  for (let k = 0; k < poly2.length; k += 1) {
    const p = poly2[k];
    const q = poly2[(k + 1) % poly2.length];
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  const estimate = (s: number): number => area / (s * s * 0.866) + perimeter / s;
  while (estimate(a) > look.maxFaceVerts) a *= 1.25;

  // --- Samples ------------------------------------------------------------
  const boundary: Vec2[] = [];
  const edgeStart: number[] = [];
  for (let k = 0; k < poly2.length; k += 1) {
    const p = poly2[k];
    const q = poly2[(k + 1) % poly2.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const steps = Math.max(1, Math.ceil(len / a));
    edgeStart.push(boundary.length);
    for (let s = 0; s < steps; s += 1) {
      boundary.push([p[0] + ((q[0] - p[0]) * s) / steps, p[1] + ((q[1] - p[1]) * s) / steps]);
    }
  }
  const interior: Vec2[] = [];
  const rowH = a * 0.8660254;
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [u, v] of poly2) {
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const contactSeed = hashU32(input.seed, contact.a, contact.b);
  for (let j = Math.floor(minV / rowH); j * rowH <= maxV; j += 1) {
    const shift = (j & 1) * a * 0.5;
    for (let i = Math.floor((minU - shift) / a); i * a + shift <= maxU; i += 1) {
      // A small deterministic jitter keeps the lattice from reading as a grid.
      const jx = (hash01(i, j, 1) - 0.5) * a * 0.3;
      const jy = (hash01(i, j, 2) - 0.5) * a * 0.3;
      const q: Vec2 = [i * a + shift + jx, j * rowH + jy];
      if (insideConvex2(q, poly2, a * 0.45)) interior.push(q);
    }
  }
  const tri = triangulateConvex(boundary, interior);
  const count = tri.points.length;

  // --- Displace -------------------------------------------------------------
  const pinnedSegs: Array<[Vec2, Vec2]> = [];
  const jaggedSegs: Array<[Vec2, Vec2]> = [];
  for (let k = 0; k < poly2.length; k += 1) {
    const seg: [Vec2, Vec2] = [poly2[k], poly2[(k + 1) % poly2.length]];
    (pinned[k] ? pinnedSegs : jaggedSegs).push(seg);
  }
  // The edges each boundary sample sits on (corners sit on two).
  const onEdges = (index: number): number[] => {
    if (index >= boundary.length) return [];
    for (let k = 0; k < poly2.length; k += 1) {
      if (edgeStart[k] === index) return [k, (k + poly2.length - 1) % poly2.length];
    }
    let k = poly2.length - 1;
    while (k > 0 && edgeStart[k] > index) k -= 1;
    return [k];
  };
  // Tilt the whole face a little: real cracks wander off the authored plane.
  const tiltA = (hash01(contactSeed, 3) - 0.5) * 2 * look.tilt;
  const tiltB = (hash01(contactSeed, 4) - 0.5) * 2 * look.tilt;
  let cu = 0;
  let cv = 0;
  for (const [u, v] of poly2) {
    cu += u / poly2.length;
    cv += v / poly2.length;
  }

  const base = new Float64Array(count * 3);
  const off = new Float64Array(count * 3);
  const relief = new Float32Array(count);
  const chipDepth = new Float32Array(count);
  const chipWidth = new Float32Array(count);
  const grain = A.grainAxis !== undefined ? axisVector(A.grainAxis) : null;
  for (let v = 0; v < count; v += 1) {
    const q = tri.points[v];
    const p0 = from2(q);
    let dPinned = Infinity;
    for (const [s0, s1] of pinnedSegs) dPinned = Math.min(dPinned, segmentDistance2(q, s0, s1));
    const w = pinnedSegs.length > 0 ? smoothstep(0, look.taper, dPinned) : 1;
    const raw = reliefHeight(p0, nc, A.cls, look, grain, input.seed)
      + tiltA * (q[0] - cu) + tiltB * (q[1] - cv);
    const h = clamp(raw, -hMax, hMax) * w;
    // Allowed motion: free inside, within the outer plane on a jagged edge,
    // along the corner line where two jagged edges meet. Pinned edges get w = 0.
    const planes = onEdges(v).map((k) => outer[k]).filter((m): m is Vec3 => m !== null);
    const project = (d: Vec3): Vec3 => {
      if (planes.length === 0) return d;
      if (planes.length === 1) return sub(d, scale(planes[0], dot(d, planes[0])));
      const line = normalize(cross(planes[0], planes[1]));
      return scale(line, dot(d, line));
    };
    const dirH = project(nc);
    const along = dot(dirH, nc);
    const disp = scale(dirH, along > 1e-6 ? h / Math.max(0.3, along) : 0);
    const recede = scale(project(nA), -look.crackOpening * w);
    // Spall: an edge vertex on ONE outer plane sinks below it, by a noisy
    // amount; the outer face bevels down to it (pieceSkin.ts).
    let dip: Vec3 = [0, 0, 0];
    if (planes.length === 1 && look.chipDepth > 0) {
      const s = 1 / Math.max(1e-4, look.chipWidth * 2.5);
      const n1 = 0.5 + 0.5 * fbm3(p0[0] * s, p0[1] * s, p0[2] * s, input.seed + 31, 2);
      const n2 = 0.5 + 0.5 * fbm3(p0[0] * s + 7.1, p0[1] * s, p0[2] * s - 3.3, input.seed + 37, 2);
      chipDepth[v] = look.chipDepth * clamp(0.2 + n1 * 1.1, 0, 1.3) * w;
      chipWidth[v] = look.chipWidth * clamp(0.35 + n2 * 0.9, 0, 1.25) * w;
      dip = scale(planes[0], -chipDepth[v]);
    }
    base[v * 3] = p0[0] + disp[0] + dip[0];
    base[v * 3 + 1] = p0[1] + disp[1] + dip[1];
    base[v * 3 + 2] = p0[2] + disp[2] + dip[2];
    off[v * 3] = recede[0];
    off[v * 3 + 1] = recede[1];
    off[v * 3 + 2] = recede[2];
    relief[v] = look.amplitude > 0 ? h / look.amplitude : 0;
  }

  // --- Normals (A side) -------------------------------------------------------
  const triangles = Uint32Array.from(tri.triangles);
  const normals = new Float32Array(count * 3);
  const accum = new Float64Array(count * 3);
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i];
    const ib = triangles[i + 1];
    const ic = triangles[i + 2];
    const pa: Vec3 = [base[ia * 3], base[ia * 3 + 1], base[ia * 3 + 2]];
    const pb: Vec3 = [base[ib * 3], base[ib * 3 + 1], base[ib * 3 + 2]];
    const pc: Vec3 = [base[ic * 3], base[ic * 3 + 1], base[ic * 3 + 2]];
    const n = cross(sub(pb, pa), sub(pc, pa));
    for (const k of [ia, ib, ic]) {
      accum[k * 3] += n[0];
      accum[k * 3 + 1] += n[1];
      accum[k * 3 + 2] += n[2];
    }
  }
  for (let v = 0; v < count; v += 1) {
    let n = normalize([accum[v * 3], accum[v * 3 + 1], accum[v * 3 + 2]]);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = nA;
    normals[v * 3] = n[0];
    normals[v * 3 + 1] = n[1];
    normals[v * 3 + 2] = n[2];
  }

  const edges: InterfaceEdge[] = poly2.map((_, k) => {
    const start = edgeStart[k];
    const end = k + 1 < poly2.length ? edgeStart[k + 1] : boundary.length;
    const indices: number[] = [];
    for (let i = start; i < end; i += 1) indices.push(i);
    indices.push(k + 1 < poly2.length ? edgeStart[k + 1] : 0);
    const m = outer[k];
    const inwardA: Vec3 = m ? normalize(scale(sub(nA, scale(m, dot(nA, m))), -1)) : [0, 0, 0];
    return { indices, jagged: !pinned[k], outer: m, inwardA, from: corners[k], to: corners[(k + 1) % corners.length] };
  });

  return {
    contact: input.contactIndex, a: contact.a, b: contact.b, faceA: contact.faceA, faceB: contact.faceB,
    normal: nA, base, off, normals, relief, chipDepth, chipWidth, triangles, edges,
  };
}

export function axisVector(axis: number): Vec3 {
  return axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1];
}

/** A vertex of the interface as piece `side` sees it, structure frame. */
export function interfacePoint(iface: CrackInterface, v: number, side: 'a' | 'b'): Vec3 {
  const s = side === 'a' ? 1 : -1;
  return [
    iface.base[v * 3] + iface.off[v * 3] * s,
    iface.base[v * 3 + 1] + iface.off[v * 3 + 1] * s,
    iface.base[v * 3 + 2] + iface.off[v * 3 + 2] * s,
  ];
}
