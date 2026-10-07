// Everything a structure's broken look needs, from pieces to meshes.
//
// One call per (structure, set of broken contacts, look version): find the
// contacts, build a crack surface per broken contact, grow rebar, and emit each
// piece's visual mesh. Pure and synchronous -- the lab runs it on the main
// thread, timed, and the city could run it in slices.

import { FaceKind, findContacts, FULL_COVER, type ContactTable, type FracturePiece } from './contacts';
import { buildInterface, type CrackInterface } from './interface';
import type { FractureLook } from './looks';
import { FractureClass } from './materialClass';
import { flatPieceMesh, pieceSkinMesh, type PieceMesh } from './pieceSkin';
import { rebarStubs, type RebarFamily, type RebarStub } from './rebar';
import { dot } from './math';
import { outerPlanes, wearInterface, WearField, type WearPlane } from './wear';

export interface AssembleOptions {
  /** Which contacts have let go. */
  broken: (contact: number) => boolean;
  /** Build crack geometry (else: flat faces, shading only). */
  rough: boolean;
  /** Round and chip the original outer edges, broken or not. */
  wear: boolean;
  rebar: boolean;
  /** Lattice density multiplier (LOD). */
  density: number;
  looks: readonly FractureLook[];
  families: readonly RebarFamily[];
  seed: number;
}

export interface AssembleStats {
  contacts: number;
  fullContacts: number;
  broken: number;
  interfaces: number;
  rebarStubs: number;
  vertices: number;
  triangles: number;
  ms: number;
}

export interface Assembled {
  meshes: PieceMesh[];
  interfaces: CrackInterface[];
  stats: AssembleStats;
}

export function assembleContacts(pieces: readonly FracturePiece[]): ContactTable {
  return findContacts(pieces);
}

export function assembleBroken(
  pieces: readonly FracturePiece[], table: ContactTable, options: AssembleOptions,
): Assembled {
  const started = performance.now();
  const perPiece = pieces.map(() => new Map<number, { iface: CrackInterface; side: 'a' | 'b' }>());
  // Each piece's outer planes, structure frame: what its edges wear against.
  const outer: WearPlane[][] = pieces.map((piece, p) => outerPlanes(piece.poly.faces
    .filter((_, f) => table.faceKind[p][f] === FaceKind.Exterior)
    .map((face) => ({ n: face.normal, w: face.d + dot(face.normal, piece.centroid) }))));
  const fieldOf = (planes: WearPlane[], cls: number): WearField | null => {
    const look = options.looks[cls].wear;
    return options.wear && look.radius > 0 && planes.length > 0 ? new WearField(planes, look, options.seed) : null;
  };
  const stubsOf = pieces.map(() => [] as RebarStub[]);
  const interfaces: CrackInterface[] = [];
  let broken = 0;
  let stubCount = 0;

  table.contacts.forEach((contact, ci) => {
    if (!options.broken(ci)) return;
    broken += 1;
    if (!options.rough) return;
    if (contact.coverA < FULL_COVER || contact.coverB < FULL_COVER) return;
    const cls = pieces[contact.a].cls;
    const iface = buildInterface({
      contact, contactIndex: ci, pieces, faceKind: table.faceKind,
      look: options.looks[cls].relief, density: options.density, seed: options.seed,
    });
    if (!iface) return;
    // Where the crack runs into a worn arris, wear it once for both pieces.
    const field = fieldOf(outerPlanes([...outer[contact.a], ...outer[contact.b]]), cls);
    if (field) wearInterface(iface, field);
    interfaces.push(iface);
    perPiece[contact.a].set(contact.faceA, { iface, side: 'a' });
    perPiece[contact.b].set(contact.faceB, { iface, side: 'b' });
    const reinforced = cls === FractureClass.Reinforced && pieces[contact.b].cls === FractureClass.Reinforced;
    if (options.rebar && reinforced && !contact.joint && options.families.length > 0) {
      for (const stub of rebarStubs(contact, options.families, options.looks[cls].rebar, ci)) {
        stubsOf[stub.side === 'a' ? contact.a : contact.b].push(stub);
        stubCount += 1;
      }
    }
  });

  const meshes = pieces.map((piece, p) => {
    const field = fieldOf(outer[p], piece.cls);
    if (!field && (!options.rough || (perPiece[p].size === 0 && stubsOf[p].length === 0))) {
      return flatPieceMesh(piece.poly, table.faceKind[p]);
    }
    const look = options.looks[piece.cls].wear;
    return pieceSkinMesh({
      piece, kinds: table.faceKind[p], interfaces: perPiece[p], stubs: stubsOf[p],
      rebarSides: options.looks[piece.cls].rebar.sides,
      wear: field ? { field, spacing: Math.max(look.radius * 1.1, 0.005) / Math.max(0.1, options.density) } : null,
    });
  });

  let vertices = 0;
  let triangles = 0;
  for (const mesh of meshes) {
    vertices += mesh.positions.length / 3;
    triangles += mesh.indices.length / 3;
  }
  return {
    meshes,
    interfaces,
    stats: {
      contacts: table.contacts.length,
      fullContacts: table.stats.full,
      broken,
      interfaces: interfaces.length,
      rebarStubs: stubCount,
      vertices,
      triangles,
      ms: performance.now() - started,
    },
  };
}

/** The baseline: every piece as the flat collider, all faces shaded as outside. */
export function assembleToday(pieces: readonly FracturePiece[]): PieceMesh[] {
  return pieces.map((piece) => flatPieceMesh(piece.poly, null));
}

export { FaceKind };
