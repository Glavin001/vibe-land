// Everything a structure's broken look needs, from pieces to meshes.
//
// `FractureBuilder` makes ONE piece's visual mesh on demand, at a level of
// detail: what a runtime does for the few hundred pieces near the camera out
// of the hundreds of thousands in a scene, a few per frame. Crack surfaces
// belong to a contact, not a piece, so they are built once and shared by
// both pieces (cached per contact and detail level). Pure and synchronous.
//
// `assembleBroken` builds every piece at once -- what the lab's whole-
// specimen view and the tests use.

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

export class FractureBuilder {
  /** Contacts touching each piece. */
  private readonly contactsOf: number[][];
  private readonly outer = new Map<number, WearPlane[]>();
  private readonly interfaces = new Map<number, CrackInterface | null>();
  private readonly stubs = new Map<number, RebarStub[]>();
  interfacesBuilt = 0;
  stubsBuilt = 0;

  constructor(
    readonly pieces: readonly FracturePiece[],
    readonly table: ContactTable,
    readonly options: AssembleOptions,
  ) {
    this.contactsOf = pieces.map(() => [] as number[]);
    table.contacts.forEach((c, ci) => {
      this.contactsOf[c.a].push(ci);
      this.contactsOf[c.b].push(ci);
    });
  }

  /** A piece's outer planes, structure frame: what its edges wear against. */
  private outerOf(p: number): WearPlane[] {
    let planes = this.outer.get(p);
    if (!planes) {
      const piece = this.pieces[p];
      planes = outerPlanes(piece.poly.faces
        .filter((_, f) => this.table.faceKind[p][f] === FaceKind.Exterior)
        .map((face) => ({ n: face.normal, w: face.d + dot(face.normal, piece.centroid) })));
      this.outer.set(p, planes);
    }
    return planes;
  }

  private fieldOf(planes: WearPlane[], cls: number): WearField | null {
    const look = this.options.looks[cls].wear;
    return this.options.wear && look.radius > 0 && planes.length > 0
      ? new WearField(planes, look, this.options.seed) : null;
  }

  /** Detail levels are discrete so crack surfaces can be shared and cached. */
  private static levelKey(ci: number, density: number): number {
    return ci * 4 + (density >= 0.99 ? 0 : density >= 0.49 ? 1 : 2);
  }

  /** The rough surface of contact ci, built once per detail level; null if it stays flat. */
  interfaceOf(ci: number, density: number): CrackInterface | null {
    const key = FractureBuilder.levelKey(ci, density);
    if (this.interfaces.has(key)) return this.interfaces.get(key)!;
    const { options, pieces, table } = this;
    const contact = table.contacts[ci];
    let iface: CrackInterface | null = null;
    if (options.rough && options.broken(ci) && contact.coverA >= FULL_COVER && contact.coverB >= FULL_COVER) {
      const cls = pieces[contact.a].cls;
      iface = buildInterface({
        contact, contactIndex: ci, pieces, faceKind: table.faceKind,
        look: options.looks[cls].relief, density, seed: options.seed,
      });
      // Where the crack runs into a worn arris, wear it once for both pieces.
      const field = iface ? this.fieldOf(outerPlanes([...this.outerOf(contact.a), ...this.outerOf(contact.b)]), cls) : null;
      if (iface && field) wearInterface(iface, field);
      if (iface) this.interfacesBuilt += 1;
    }
    this.interfaces.set(key, iface);
    return iface;
  }

  /** The bars snapped across contact ci (both sides), built once. */
  stubsOf(ci: number): RebarStub[] {
    let list = this.stubs.get(ci);
    if (!list) {
      list = [];
      const { options, pieces, table } = this;
      const contact = table.contacts[ci];
      const cls = pieces[contact.a].cls;
      const reinforced = cls === FractureClass.Reinforced && pieces[contact.b].cls === FractureClass.Reinforced;
      if (options.rough && options.rebar && options.broken(ci) && reinforced && !contact.joint
        && options.families.length > 0 && contact.coverA >= FULL_COVER && contact.coverB >= FULL_COVER) {
        list = rebarStubs(contact, options.families, options.looks[cls].rebar, ci);
        this.stubsBuilt += list.length;
      }
      this.stubs.set(ci, list);
    }
    return list;
  }

  /** Piece p's visual mesh at a detail level (1 = the look's own density). */
  pieceMesh(p: number, detail = 1): PieceMesh {
    const { options, pieces, table } = this;
    const piece = pieces[p];
    const density = options.density * detail;
    const interfaces = new Map<number, { iface: CrackInterface; side: 'a' | 'b' }>();
    const stubs: RebarStub[] = [];
    for (const ci of this.contactsOf[p]) {
      const contact = table.contacts[ci];
      const iface = this.interfaceOf(ci, density);
      const side = contact.a === p ? 'a' : 'b';
      if (iface) interfaces.set(side === 'a' ? contact.faceA : contact.faceB, { iface, side });
      for (const stub of this.stubsOf(ci)) if (stub.side === side) stubs.push(stub);
    }
    const field = this.fieldOf(this.outerOf(p), piece.cls);
    if (!field && interfaces.size === 0 && stubs.length === 0) return flatPieceMesh(piece.poly, table.faceKind[p]);
    const look = options.looks[piece.cls].wear;
    return pieceSkinMesh({
      piece, kinds: table.faceKind[p], interfaces, stubs,
      rebarSides: options.looks[piece.cls].rebar.sides,
      wear: field ? { field, spacing: Math.max(look.radius * 1.2, 0.01) / Math.max(0.1, density) } : null,
    });
  }

  /** The shading-only mesh: the flat collider with its faces' kinds. */
  flatMesh(p: number): PieceMesh {
    return flatPieceMesh(this.pieces[p].poly, this.table.faceKind[p]);
  }
}

export function assembleBroken(
  pieces: readonly FracturePiece[], table: ContactTable, options: AssembleOptions,
): Assembled {
  const started = performance.now();
  const builder = new FractureBuilder(pieces, table, options);
  const meshes = pieces.map((_, p) => builder.pieceMesh(p));
  const interfaces: CrackInterface[] = [];
  let broken = 0;
  table.contacts.forEach((_, ci) => {
    if (!options.broken(ci)) return;
    broken += 1;
    const iface = builder.interfaceOf(ci, options.density);
    if (iface) interfaces.push(iface);
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
      rebarStubs: builder.stubsBuilt,
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
