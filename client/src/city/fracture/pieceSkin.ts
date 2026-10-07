// A piece's VISUAL mesh: its collider polytope, with every broken contact
// replaced by the shared crack surface and every outer face re-outlined along
// the cracks' jagged edges, plus whatever sticks out of the break (rebar).
//
// The flat variant (`flatPieceMesh`) is the collider as the city draws it
// today -- the baseline the lab compares against.

import { ShapeUtils, Vector2 } from 'three';

import { anyBasis, faceAcross, type Polytope } from './polytope';
import { FaceKind, type FracturePiece } from './contacts';
import { interfacePoint, type CrackInterface } from './interface';
import { appendTube, type RebarStub, type TubeMesh } from './rebar';
import { add, cross, dot, orient2, scale, sub, type Vec2, type Vec3 } from './math';
import { canonicalSign } from './canonical';

export interface PieceMesh {
  /** Piece-local positions (centroid-relative, rest orientation). */
  positions: number[];
  normals: number[];
  /** FaceKind per vertex. */
  kinds: number[];
  /** Crack relief / amplitude per vertex (0 off the crack). */
  relief: number[];
  /**
   * Which piece of its crack this face is: the sign of its outward normal
   * against the canonical direction (canonical.ts). The shader mirrors relief
   * by it, so a stone proud on one piece is a socket on the other.
   */
  sides: number[];
  indices: number[];
}

const emptyMesh = (): PieceMesh => ({ positions: [], normals: [], kinds: [], relief: [], sides: [], indices: [] });

/**
 * The collider as drawn today: each face a flat fan. `kinds` marks cut faces
 * so the fracture SHADING can be shown without any change in geometry.
 */
export function flatPieceMesh(poly: Polytope, kinds: Uint8Array | null): PieceMesh {
  const mesh = emptyMesh();
  poly.faces.forEach((face, f) => {
    const kind = kinds ? kinds[f] : FaceKind.Exterior;
    const side = canonicalSign(face.normal);
    const start = mesh.positions.length / 3;
    for (const i of face.loop) {
      const v = poly.verts[i];
      mesh.positions.push(v[0], v[1], v[2]);
      mesh.normals.push(face.normal[0], face.normal[1], face.normal[2]);
      mesh.kinds.push(kind);
      mesh.relief.push(0);
      mesh.sides.push(side);
    }
    for (let k = 1; k + 1 < face.loop.length; k += 1) mesh.indices.push(start, start + k, start + k + 1);
  });
  return mesh;
}

export interface SkinInput {
  piece: FracturePiece;
  kinds: Uint8Array;
  /** This piece's broken contacts' surfaces, by the face they replace. */
  interfaces: Map<number, { iface: CrackInterface; side: 'a' | 'b' }>;
  stubs: readonly RebarStub[];
  rebarSides: number;
}

const near = (p: Vec3, q: Vec3, tol = 1e-4): boolean =>
  Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol && Math.abs(p[2] - q[2]) < tol;

export function pieceSkinMesh(input: SkinInput): PieceMesh {
  const { piece, kinds, interfaces } = input;
  const poly = piece.poly;
  const mesh = emptyMesh();
  const world = (i: number): Vec3 => add(poly.verts[i], piece.centroid);

  // Corners a crack moved (only where two jagged edges meet): every face
  // touching that vertex must use the moved position.
  const moved = new Map<number, Vec3>();
  for (const { iface, side } of interfaces.values()) {
    iface.edges.forEach((edge, k) => {
      const prev = iface.edges[(k + iface.edges.length - 1) % iface.edges.length];
      if (!edge.jagged || !prev.jagged) return;
      const corner = edge.indices[0];
      for (let i = 0; i < poly.verts.length; i += 1) {
        if (near(world(i), edge.from)) moved.set(i, interfacePoint(iface, corner, side));
      }
    });
  }
  const at = (i: number): Vec3 => moved.get(i) ?? world(i);

  poly.faces.forEach((face, f) => {
    const replaced = interfaces.get(f);
    if (replaced) {
      appendInterface(mesh, replaced.iface, replaced.side, piece.centroid, kinds[f]);
      return;
    }
    // Outline, splicing in the jagged crack edges of neighbouring faces. Where
    // the crack spalled, the face stops short of the edge (the inset line)
    // and bevels down to it.
    const outline: Vec3[] = [];
    for (let k = 0; k < face.loop.length; k += 1) {
      const i = face.loop[k];
      const j = face.loop[(k + 1) % face.loop.length];
      const g = faceAcross(poly, i, j);
      const across = interfaces.get(g);
      let run: Vec3[] | null = null;
      if (across) {
        const wi = world(i);
        const wj = world(j);
        for (const edge of across.iface.edges) {
          if (!edge.jagged || !edge.outer) continue;
          let indices: number[] | null = null;
          if (near(edge.from, wi) && near(edge.to, wj)) indices = edge.indices;
          else if (near(edge.from, wj) && near(edge.to, wi)) indices = edge.indices.slice().reverse();
          if (!indices) continue;
          const { iface, side } = across;
          const inward = side === 'a' ? edge.inwardA : [-edge.inwardA[0], -edge.inwardA[1], -edge.inwardA[2]] as Vec3;
          const lip = indices.map((v) => interfacePoint(iface, v, side));
          const inset = indices.map((v, n) => add(add(lip[n], scale(edge.outer!, iface.chipDepth[v])), scale(inward, iface.chipWidth[v])));
          if (indices.some((v) => iface.chipWidth[v] > 0)) {
            const crackSide = canonicalSign(iface.normal) * (side === 'a' ? 1 : -1);
            appendBevel(mesh, lip, inset, edge.outer, inward, piece.centroid, kinds[g], crackSide);
          }
          run = inset;
          break;
        }
      }
      run = run ?? [at(i), at(j)];
      for (let s = 0; s + 1 < run.length; s += 1) outline.push(run[s]);
    }
    appendPolygon(mesh, outline, face.normal, piece.centroid, kinds[f]);
  });

  if (input.stubs.length > 0) {
    const tube: TubeMesh = { positions: [], normals: [], along: [], indices: [] };
    for (const stub of input.stubs) appendTube(tube, stub.points, stub.radius, input.rebarSides, piece.centroid);
    const start = mesh.positions.length / 3;
    mesh.positions.push(...tube.positions);
    mesh.normals.push(...tube.normals);
    for (let i = 0; i < tube.positions.length / 3; i += 1) {
      mesh.kinds.push(FaceKind.Rebar);
      // Rebar carries its distance along the bar here; the shader rolls ribs from it.
      mesh.relief.push(tube.along[i]);
      mesh.sides.push(1);
    }
    for (const i of tube.indices) mesh.indices.push(start + i);
  }
  return mesh;
}

function appendInterface(mesh: PieceMesh, iface: CrackInterface, side: 'a' | 'b', origin: Vec3, kind: number): void {
  const start = mesh.positions.length / 3;
  const count = iface.relief.length;
  const s = side === 'a' ? 1 : -1;
  const canonical = canonicalSign(iface.normal) * s;
  for (let v = 0; v < count; v += 1) {
    const p = interfacePoint(iface, v, side);
    mesh.positions.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
    mesh.normals.push(iface.normals[v * 3] * s, iface.normals[v * 3 + 1] * s, iface.normals[v * 3 + 2] * s);
    mesh.kinds.push(kind);
    mesh.relief.push(iface.relief[v] * s);
    mesh.sides.push(canonical);
  }
  const tris = iface.triangles;
  for (let i = 0; i < tris.length; i += 3) {
    if (side === 'a') mesh.indices.push(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
    else mesh.indices.push(start + tris[i], start + tris[i + 2], start + tris[i + 1]);
  }
}

/**
 * The spalled strip between a crack's sunken lip and the outer face's inset
 * line: broken material, shaded as the crack is. Flat-shaded per triangle,
 * facing out of the face and toward the crack.
 */
function appendBevel(
  mesh: PieceMesh, lip: readonly Vec3[], inset: readonly Vec3[], outer: Vec3, inward: Vec3,
  origin: Vec3, kind: number, side: number,
): void {
  const facing = sub(outer, scale(inward, 0.6));
  const tri = (a: Vec3, b: Vec3, c: Vec3): void => {
    let n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) return;
    if (dot(n, facing) < 0) {
      const t = b;
      b = c;
      c = t;
      n = scale(n, -1);
    }
    n = scale(n, 1 / len);
    const start = mesh.positions.length / 3;
    for (const p of [a, b, c]) {
      mesh.positions.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
      mesh.normals.push(n[0], n[1], n[2]);
      mesh.kinds.push(kind);
      mesh.relief.push(-0.4);
      mesh.sides.push(side);
    }
    mesh.indices.push(start, start + 1, start + 2);
  };
  for (let k = 0; k + 1 < lip.length; k += 1) {
    tri(lip[k], lip[k + 1], inset[k + 1]);
    tri(lip[k], inset[k + 1], inset[k]);
  }
}

/** A planar (possibly non-convex, after splicing) polygon, earcut. */
function appendPolygon(mesh: PieceMesh, outline: Vec3[], normal: Vec3, origin: Vec3, kind: number): void {
  if (outline.length < 3) return;
  const { t, b } = anyBasis(normal);
  const side = canonicalSign(normal);
  const pts2: Vec2[] = outline.map((p) => [dot(p, t), dot(p, b)]);
  const start = mesh.positions.length / 3;
  for (const p of outline) {
    const local = sub(p, origin);
    mesh.positions.push(local[0], local[1], local[2]);
    mesh.normals.push(normal[0], normal[1], normal[2]);
    mesh.kinds.push(kind);
    mesh.relief.push(0);
    mesh.sides.push(side);
  }
  if (outline.length === 3) {
    mesh.indices.push(start, start + 1, start + 2);
    return;
  }
  const triangles = ShapeUtils.triangulateShape(pts2.map(([x, y]) => new Vector2(x, y)), []);
  for (const [a, b2, c] of triangles) {
    // (t, b, n) is right-handed: CCW in 2D faces along +normal.
    if (orient2(pts2[a], pts2[b2], pts2[c]) >= 0) mesh.indices.push(start + a, start + b2, start + c);
    else mesh.indices.push(start + a, start + c, start + b2);
  }
}
