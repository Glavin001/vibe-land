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

export interface AssembleOptions {
  /** Which contacts have let go. */
  broken: (contact: number) => boolean;
  /** Build crack geometry (else: flat faces, shading only). */
  rough: boolean;
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
    if (!options.rough || (perPiece[p].size === 0 && stubsOf[p].length === 0)) {
      return flatPieceMesh(piece.poly, table.faceKind[p]);
    }
    return pieceSkinMesh({
      piece, kinds: table.faceKind[p], interfaces: perPiece[p], stubs: stubsOf[p],
      rebarSides: options.looks[piece.cls].rebar.sides,
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
