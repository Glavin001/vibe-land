// A piece's VISUAL mesh: its collider polytope, with every broken contact
// replaced by the shared crack surface, every outer face re-outlined along
// the cracks' jagged edges, the original outer edges worn (rounded and
// chipped, wear.ts), plus whatever sticks out of the break (rebar).
//
// The flat variant (`flatPieceMesh`) is the collider as the city draws it
// today -- the baseline the lab compares against.

import { ShapeUtils, Vector2 } from 'three';

import { canonicalSign } from './canonical';
import { FaceKind, type FracturePiece } from './contacts';
import { refine } from './delaunay2d';
import { interfacePoint, type CrackInterface } from './interface';
import { add, cross, distance, dot, insideConvex2, lerp, normalize, orient2, scale, segmentDistance2, sub, type Vec2, type Vec3 } from './math';
import { anyBasis, faceAcross, type Polytope } from './polytope';
import { appendTube, type RebarStub, type TubeMesh } from './rebar';
import type { WearField } from './wear';

export interface PieceMesh {
  /** Piece-local positions (centroid-relative, rest orientation). */
  positions: number[];
  normals: number[];
  /** FaceKind per vertex. */
  kinds: number[];
  /**
   * Crack relief / amplitude on crack faces; on outer faces, how worn the
   * surface is there (0 pristine, ~1 at the rounded arris, more in a chip);
   * distance along the bar on rebar.
   */
  relief: number[];
  /**
   * Which piece of its crack this face is: the sign of its outward normal
   * against the canonical direction (canonical.ts). The shader mirrors relief
   * by it, so a stone proud on one piece is a socket on the other.
   */
  sides: number[];
  indices: number[];
}

export const emptyMesh = (): PieceMesh => ({ positions: [], normals: [], kinds: [], relief: [], sides: [], indices: [] });

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

export interface SkinWear {
  field: WearField;
  /** Sample spacing along worn edges, metres. */
  spacing: number;
}

export interface SkinInput {
  piece: FracturePiece;
  kinds: Uint8Array;
  /** This piece's broken contacts' surfaces, by the face they replace. */
  interfaces: Map<number, { iface: CrackInterface; side: 'a' | 'b' }>;
  stubs: readonly RebarStub[];
  rebarSides: number;
  /** Round and chip the original outer edges. */
  wear: SkinWear | null;
}

const near = (p: Vec3, q: Vec3, tol = 1e-4): boolean =>
  Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol && Math.abs(p[2] - q[2]) < tol;

/** One outline point: where it is, and whether wear may still move it. */
interface OutlinePoint {
  p: Vec3;
  /** Came from a crack surface, which was worn once for both pieces. */
  frozen: boolean;
}

export function pieceSkinMesh(input: SkinInput): PieceMesh {
  const { piece, kinds, interfaces, wear } = input;
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
  const at = (i: number): OutlinePoint => {
    const m = moved.get(i);
    return m ? { p: m, frozen: true } : { p: world(i), frozen: false };
  };

  // Worn edges: original arrises, where two OUTER faces meet.
  const isWorn = (f: number, i: number, j: number): boolean => {
    if (!wear || kinds[f] !== FaceKind.Exterior) return false;
    const g = faceAcross(poly, i, j);
    return g >= 0 && kinds[g] === FaceKind.Exterior;
  };
  const wornVertex = new Set<number>();
  if (wear) {
    poly.faces.forEach((face, f) => {
      for (let k = 0; k < face.loop.length; k += 1) {
        const i = face.loop[k];
        const j = face.loop[(k + 1) % face.loop.length];
        if (isWorn(f, i, j)) {
          wornVertex.add(i);
          wornVertex.add(j);
        }
      }
    });
  }
  const project = makeProjector(piece, kinds, wear);
  // Boundary points an outer face put on a shared straight edge, so the cut
  // or joint face on the other side of that edge walks exactly the same
  // points (key: the edge's vertex indices, low first; points low to high).
  const recorded = new Map<string, Vec3[]>();
  const edgeKeyOf = (i: number, j: number): string => (i < j ? `${i},${j}` : `${j},${i}`);
  const recordedRun = (i: number, j: number): Vec3[] | null => {
    const points = recorded.get(edgeKeyOf(i, j));
    if (!points) return null;
    return i < j ? points : points.slice().reverse();
  };

  const buildFace = (face: Polytope['faces'][number], f: number): void => {
    const replaced = interfaces.get(f);
    if (replaced) {
      appendInterface(mesh, replaced.iface, replaced.side, piece.centroid, kinds[f]);
      return;
    }
    // Outline, splicing in the jagged crack edges of neighbouring faces. Where
    // the crack spalled, the face stops short of the edge (the inset line)
    // and bevels down to it. Straight edges are subdivided where wear will
    // bend them.
    const outline: OutlinePoint[] = [];
    const wornSegments: Array<[Vec3, Vec3]> = [];
    // The face's own corners while nothing has been spliced in: a convex
    // polygon, which can take the structured worn-band layout.
    const corners: OutlinePoint[] = [];
    const wornFlags: boolean[] = [];
    const cornerIndex: number[] = [];
    let spliced = false;
    for (let k = 0; k < face.loop.length; k += 1) {
      const i = face.loop[k];
      const j = face.loop[(k + 1) % face.loop.length];
      const g = faceAcross(poly, i, j);
      const across = interfaces.get(g);
      let run: OutlinePoint[] | null = null;
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
            appendBevel(mesh, lip, inset, edge.outer, inward, piece.centroid, kinds[g], crackSide, project);
          }
          // The inset line is this face's own, so wear may still move it.
          run = inset.map((p, n) => ({ p, frozen: iface.chipWidth[indices![n]] <= 0 }));
          spliced = true;
          break;
        }
      }
      if (!run) {
        const a = at(i);
        const b = at(j);
        corners.push(a);
        cornerIndex.push(i);
        const wornEdge = isWorn(f, i, j);
        wornFlags.push(wornEdge);
        if (wornEdge) wornSegments.push([a.p, b.p]);
        const known = recordedRun(i, j);
        const middle = known
          ? known.map((p) => ({ p, frozen: false }))
          : edgeSamples(a.p, b.p, wornEdge, wornVertex.has(i), wornVertex.has(j), wear);
        if (!known && !wornEdge && middle.length > 0) {
          recorded.set(edgeKeyOf(i, j), (i < j ? middle : middle.slice().reverse()).map((o) => o.p));
        }
        run = [a, ...middle, b];
      }
      for (let s = 0; s + 1 < run.length; s += 1) outline.push(run[s]);
    }
    if (wear && !spliced && wornSegments.length > 0) {
      const sides = appendWornFace(mesh, corners, wornFlags, face.normal, piece.centroid, kinds[f], wear, project);
      if (sides) {
        // Record what this face put on its plain edges, for the faces beyond.
        sides.forEach((points, k) => {
          if (wornFlags[k] || points.length === 0) return;
          const i = cornerIndex[k];
          const j = cornerIndex[(k + 1) % cornerIndex.length];
          recorded.set(edgeKeyOf(i, j), i < j ? points : points.slice().reverse());
        });
        return;
      }
    }
    const band = wear && wornSegments.length > 0
      ? bandPoints(spliced ? outline.map((o) => o.p) : corners.map((c) => c.p), !spliced, wornSegments, face.normal, wear)
      : [];
    appendPolygon(mesh, outline, band, face.normal, piece.centroid, kinds[f], project);
  };
  // Outer faces first: they decide the points shared edges carry.
  poly.faces.forEach((face, f) => { if (kinds[f] === FaceKind.Exterior) buildFace(face, f); });
  poly.faces.forEach((face, f) => { if (kinds[f] !== FaceKind.Exterior) buildFace(face, f); });

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

/**
 * Distances from a worn arris at which the worn band places its rows: a
 * geometric series, dense where the rounding bends most. Shared by the rows
 * of a structured face and the graded samples of the edges beyond it, so the
 * two land on the same points where they meet at right angles.
 */
function gradedDistances(wear: SkinWear, limit = Infinity): number[] {
  const out: number[] = [];
  for (let d = wear.spacing * 0.5; d < Math.min(wear.field.reach * 0.9, limit); d *= 2) out.push(d);
  return out;
}

/**
 * A convex outer face with worn edges, laid out as rows instead of
 * triangulated: row r is the face polygon offset inward by d_r along its worn
 * edges (plain edges stay put, so each row's corners slide along them), worn
 * edges are sampled at the same count in every row, rows are stitched with
 * quads, and the innermost row is fanned. No Delaunay, no point location:
 * linear in the vertices, and two pieces sharing a seam compute the same
 * points on it because they offset the same lines by the same distances.
 *
 * Returns, per polygon edge, the points it put between that edge's corners
 * (empty for edges with none), or null when the face is too small to take
 * any rows (the caller falls back to the general path).
 */
function appendWornFace(
  mesh: PieceMesh, corners: readonly OutlinePoint[], worn: readonly boolean[], normal: Vec3,
  origin: Vec3, kind: number, wear: SkinWear, project: Projector,
): Vec3[][] | null {
  const m = corners.length;
  if (m < 3) return null;
  const { t, b } = anyBasis(normal);
  const to2 = (p: Vec3): Vec2 => [dot(p, t), dot(p, b)];
  const plane = dot(corners[0].p, normal);
  const from2 = (q: Vec2): Vec3 => add(add(scale(t, q[0]), scale(b, q[1])), scale(normal, plane));
  const c2 = corners.map((c) => to2(c.p));
  // Inward normals of each edge (CCW polygon: the inside is to the left).
  const inward = c2.map((p, i) => {
    const q = c2[(i + 1) % m];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    return [-(q[1] - p[1]) / l, (q[0] - p[0]) / l] as Vec2;
  });
  const offsetPolygon = (d: number): Vec2[] | null => {
    const out: Vec2[] = [];
    for (let i = 0; i < m; i += 1) {
      const h = (i + m - 1) % m;
      // Corner i is where edge h (shifted) meets edge i (shifted).
      const dh = worn[h] ? d : 0;
      const di = worn[i] ? d : 0;
      const p0: Vec2 = [c2[h][0] + inward[h][0] * dh, c2[h][1] + inward[h][1] * dh];
      const r0: Vec2 = [c2[i][0] - c2[h][0], c2[i][1] - c2[h][1]];
      const p1: Vec2 = [c2[i][0] + inward[i][0] * di, c2[i][1] + inward[i][1] * di];
      const r1: Vec2 = [c2[(i + 1) % m][0] - c2[i][0], c2[(i + 1) % m][1] - c2[i][1]];
      const den = r0[0] * r1[1] - r0[1] * r1[0];
      if (Math.abs(den) < 1e-12) return null;
      const s = ((p1[0] - p0[0]) * r1[1] - (p1[1] - p0[1]) * r1[0]) / den;
      out.push([p0[0] + r0[0] * s, p0[1] + r0[1] * s]);
    }
    // Still the same polygon, just smaller: every edge keeps its direction.
    for (let i = 0; i < m; i += 1) {
      const a = out[i];
      const c = out[(i + 1) % m];
      const e0: Vec2 = [c2[(i + 1) % m][0] - c2[i][0], c2[(i + 1) % m][1] - c2[i][1]];
      if ((c[0] - a[0]) * e0[0] + (c[1] - a[1]) * e0[1] <= 0) return null;
    }
    return out;
  };
  // Rows depend only on the material, never on this face's size, so the
  // neighbour across a seam offsets the same lines by the same amounts.
  const rows: Vec2[][] = [c2];
  for (const d of gradedDistances(wear)) {
    const row = offsetPolygon(d);
    if (!row) break;
    rows.push(row);
  }
  if (rows.length < 2) return null;
  // Samples per edge, the same in every row: worn edges are subdivided.
  const counts = c2.map((p, i) => {
    if (!worn[i]) return 1;
    const q = c2[(i + 1) % m];
    return Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / wear.spacing));
  });
  const side = canonicalSign(normal);
  const start = mesh.positions.length / 3;
  const emit = (q: Vec2, frozen: boolean): number => {
    const out = project({ p: from2(q), frozen }, kind);
    const n = out.normal ?? normal;
    mesh.positions.push(out.p[0] - origin[0], out.p[1] - origin[1], out.p[2] - origin[2]);
    mesh.normals.push(n[0], n[1], n[2]);
    mesh.kinds.push(kind);
    mesh.relief.push(out.wear);
    mesh.sides.push(side);
    return mesh.positions.length / 3 - 1 - start;
  };
  // Row r as a closed ring of vertex indices, edge by edge.
  const ringOf = (r: number): number[][] => rows[r].map((p, i) => {
    const q = rows[r][(i + 1) % m];
    const ids: number[] = [];
    for (let k = 0; k < counts[i]; k += 1) {
      const u = k / counts[i];
      // The outer row's corners are the polytope's (and may be frozen).
      ids.push(r === 0 && k === 0 ? emit(c2[i], corners[i].frozen) : emit([p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u], false));
    }
    return ids;
  });
  const rings = rows.map((_, r) => ringOf(r));
  const at = (r: number, i: number, k: number): number =>
    (k < counts[i] ? rings[r][i][k] : rings[r][(i + 1) % m][0]) + start;
  for (let r = 0; r + 1 < rows.length; r += 1) {
    for (let i = 0; i < m; i += 1) {
      // A plain edge: rows r and r + 1 lie on one line here, so there is
      // nothing between them; the worn neighbours' strips end on it.
      if (!worn[i]) continue;
      for (let k = 0; k < counts[i]; k += 1) {
        const a = at(r, i, k);
        const c = at(r, i, k + 1);
        const d = at(r + 1, i, k + 1);
        const e = at(r + 1, i, k);
        mesh.indices.push(a, c, d, a, d, e);
      }
    }
  }
  // The innermost row: a fan from its centroid (it is convex).
  const inner = rows[rows.length - 1];
  let cx = 0;
  let cy = 0;
  for (const p of inner) {
    cx += p[0] / inner.length;
    cy += p[1] / inner.length;
  }
  const centre = emit([cx, cy], false) + start;
  const last = rows.length - 1;
  for (let i = 0; i < m; i += 1) {
    for (let k = 0; k < counts[i]; k += 1) mesh.indices.push(centre, at(last, i, k), at(last, i, k + 1));
  }
  // What each plain edge now carries between its corners, in order: the
  // corners its worn neighbours slid along it, row by row.
  return c2.map((_, i) => {
    if (worn[i]) return [];
    const j = (i + 1) % m;
    const points: Vec3[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      if (worn[(i + m - 1) % m]) points.push(from2(rows[r][i]));
    }
    const tail: Vec3[] = [];
    for (let r = 1; r < rows.length; r += 1) {
      if (worn[j]) tail.push(from2(rows[r][j]));
    }
    return [...points, ...tail.reverse()];
  });
}

/** A vertex as emitted: final position, normal and wear. */
interface Projected {
  p: Vec3;
  normal: Vec3 | null;
  wear: number;
}

type Projector = (point: OutlinePoint, kind: number) => Projected;

/**
 * Wear a surface point onto the piece's worn surface. Points on a cut or
 * joint face slide only within it; outer points take the worn surface's
 * normal so the rounding SHADES round. Memoised per point, so every face that
 * shares a vertex moves it identically.
 */
function makeProjector(piece: FracturePiece, kinds: Uint8Array, wear: SkinWear | null): Projector {
  if (!wear) return (point) => ({ p: point.p, normal: null, wear: 0 });
  const poly = piece.poly;
  const planes = poly.faces.map((face) => ({ n: face.normal, w: face.d + dot(face.normal, piece.centroid) }));
  const memo = new Map<string, Projected>();
  const radius = Math.max(1e-5, wear.field.look.radius);
  return (point, kind) => {
    if (point.frozen) return { p: point.p, normal: null, wear: 0 };
    const key = `${Math.round(point.p[0] * 1e6)},${Math.round(point.p[1] * 1e6)},${Math.round(point.p[2] * 1e6)},${kind === FaceKind.Exterior ? 1 : 0}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const constraints: Vec3[] = [];
    planes.forEach((plane, f) => {
      if (kinds[f] !== FaceKind.Exterior && Math.abs(dot(plane.n, point.p) - plane.w) < 2e-4) constraints.push(plane.n);
    });
    const out = wear.field.project(point.p, constraints);
    const result: Projected = {
      p: out.x,
      normal: kind === FaceKind.Exterior && out.depth > 1e-7 ? out.normal : null,
      wear: kind === FaceKind.Exterior ? out.depth / radius : 0,
    };
    memo.set(key, result);
    return result;
  };
}

/**
 * Extra samples on a straight outline edge: evenly along a worn edge (so the
 * rounding has vertices to bend), graded toward an end that touches a worn
 * edge (so a seam face follows the rounded profile). A pure function of the
 * edge's endpoints, so both faces sharing it agree.
 */
function edgeSamples(a: Vec3, b: Vec3, worn: boolean, aWorn: boolean, bWorn: boolean, wear: SkinWear | null): OutlinePoint[] {
  if (!wear) return [];
  const len = distance(a, b);
  if (len < 1e-6) return [];
  const ts: number[] = [];
  if (worn) {
    const n = Math.max(1, Math.ceil(len / wear.spacing));
    for (let k = 1; k < n; k += 1) ts.push(k / n);
  } else if (aWorn || bWorn) {
    for (const d of gradedDistances(wear, len * 0.45)) {
      if (aWorn) ts.push(d / len);
      if (bWorn) ts.push(1 - d / len);
    }
    ts.sort((x, y) => x - y);
  }
  return ts.map((t) => ({ p: lerp(a, b, t), frozen: false }));
}

/**
 * Interior points in a band along a face's worn edges: rows at growing
 * distance, so the rounded arris has vertices to bend across. Only points
 * clearly inside the outline are kept.
 */
function bandPoints(
  outline: readonly Vec3[], convex: boolean, worn: ReadonlyArray<[Vec3, Vec3]>, normal: Vec3, wear: SkinWear,
): Vec3[] {
  const { t, b } = anyBasis(normal);
  const to2 = (p: Vec3): Vec2 => [dot(p, t), dot(p, b)];
  const poly2 = outline.map(to2);
  const reach = wear.field.reach * 1.2;
  const points: Vec3[] = [];
  for (const [a, c] of worn) {
    const len = distance(a, c);
    if (len < 1e-6) continue;
    const dir = normalize(sub(c, a));
    // CCW loop about the normal: the face lies to the left of each edge.
    const inward = normalize(cross(normal, dir));
    // Few rows: the vertex normals (the field's gradient) do the rounding's
    // shading; the rows only have to carry its silhouette and its chips.
    for (let d = wear.spacing * 0.6; d < reach * 0.85; d *= 2.2) {
      const along = wear.spacing * (1 + (d / reach) * 2.5);
      const n = Math.max(1, Math.round(len / along));
      for (let k = 0; k <= n; k += 1) {
        const p = add(lerp(a, c, k / n), scale(inward, d));
        const q = to2(p);
        if (convex) {
          if (insideConvex2(q, poly2, along * 0.4)) points.push(p);
          continue;
        }
        if (!insidePolygon(q, poly2)) continue;
        let clear = Infinity;
        for (let s = 0; s < poly2.length; s += 1) {
          clear = Math.min(clear, segmentDistance2(q, poly2[s], poly2[(s + 1) % poly2.length]));
        }
        if (clear > along * 0.4) points.push(p);
      }
    }
  }
  return points;
}

function insidePolygon(q: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i];
    const b = poly[j];
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
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
  origin: Vec3, kind: number, side: number, project: Projector,
): void {
  const facing = sub(outer, scale(inward, 0.6));
  // The inset line is shared with the outer face, which wear may move: move
  // it here identically. The lip came from the crack surface, already worn.
  const moved = inset.map((p) => project({ p, frozen: false }, kind).p);
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
    tri(lip[k], lip[k + 1], moved[k + 1]);
    tri(lip[k], moved[k + 1], moved[k]);
  }
}

/**
 * A planar polygon (non-convex after splicing), earcut, then refined with
 * the band points so worn edges have vertices to bend. Every vertex goes
 * through the wear projector on its way out.
 */
function appendPolygon(
  mesh: PieceMesh, outline: OutlinePoint[], band: readonly Vec3[], normal: Vec3, origin: Vec3, kind: number,
  project: Projector,
): void {
  if (outline.length < 3) return;
  const { t, b } = anyBasis(normal);
  const side = canonicalSign(normal);
  const to2 = (p: Vec3): Vec2 => [dot(p, t), dot(p, b)];
  const pts2: Vec2[] = outline.map((o) => to2(o.p));
  let triangles: number[] = [];
  if (outline.length === 3) {
    triangles = orient2(pts2[0], pts2[1], pts2[2]) >= 0 ? [0, 1, 2] : [0, 2, 1];
  } else {
    for (const [a, b2, c] of ShapeUtils.triangulateShape(pts2.map(([x, y]) => new Vector2(x, y)), [])) {
      // (t, b, n) is right-handed: CCW in 2D faces along +normal.
      if (orient2(pts2[a], pts2[b2], pts2[c]) >= 0) triangles.push(a, b2, c);
      else triangles.push(a, c, b2);
    }
  }
  const points: OutlinePoint[] = [...outline, ...band.map((p) => ({ p, frozen: false }))];
  if (band.length > 0) triangles = refine([...pts2, ...band.map(to2)], triangles, outline.length);
  const start = mesh.positions.length / 3;
  for (const point of points) {
    const out = project(point, kind);
    const n = out.normal ?? normal;
    mesh.positions.push(out.p[0] - origin[0], out.p[1] - origin[1], out.p[2] - origin[2]);
    mesh.normals.push(n[0], n[1], n[2]);
    mesh.kinds.push(kind);
    mesh.relief.push(out.wear);
    mesh.sides.push(side);
  }
  for (const i of triangles) mesh.indices.push(start + i);
}
