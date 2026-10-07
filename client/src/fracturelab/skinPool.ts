// A fixed-capacity GPU buffer for the detailed meshes of the pieces nearest
// the camera: the runtime shape of "Tier 1" (rough cracks, worn edges, rebar)
// for scenes of hundreds of thousands of pieces.
//
// Pieces come and go as the camera moves: each takes a contiguous run of
// vertices and indices (first fit, coalesced on free), only the runs written
// are uploaded (addUpdateRange), and a freed run's indices are zeroed so it
// draws nothing. The layout matches buildLabGeometry, so the same material
// (with tier 'skin') draws it.
//
// One vertex buffer, but an index buffer PER MATERIAL CLASS (`parts`): each
// class draws with a shader specialised to it (material sorting, as the
// shading-only tier does), and the vertex data is shared. A class's index
// buffer grows (re-uploaded whole, once) if the scene needs more of it.
//
// Only imported behind __WEBGPU__.

import * as THREE from 'three';

import type { FracturePiece } from '../city/fracture/contacts';
import type { PieceMesh } from '../city/fracture/pieceSkin';
import type { LabPieceLook } from './labMesh';

interface Run {
  start: number;
  size: number;
}

class RunAllocator {
  private free: Run[];
  used = 0;
  constructor(public capacity: number) {
    this.free = [{ start: 0, size: capacity }];
  }
  allocate(size: number): number {
    for (let i = 0; i < this.free.length; i += 1) {
      const run = this.free[i];
      if (run.size < size) continue;
      const start = run.start;
      run.start += size;
      run.size -= size;
      if (run.size === 0) this.free.splice(i, 1);
      this.used += size;
      return start;
    }
    return -1;
  }
  release(start: number, size: number): void {
    this.used -= size;
    // Insert sorted, then merge with neighbours.
    let i = 0;
    while (i < this.free.length && this.free[i].start < start) i += 1;
    this.free.splice(i, 0, { start, size });
    if (i + 1 < this.free.length && this.free[i].start + this.free[i].size === this.free[i + 1].start) {
      this.free[i].size += this.free[i + 1].size;
      this.free.splice(i + 1, 1);
    }
    if (i > 0 && this.free[i - 1].start + this.free[i - 1].size === this.free[i].start) {
      this.free[i - 1].size += this.free[i].size;
      this.free.splice(i, 1);
    }
  }
  /** Grow to `capacity`: the new space is one free run at the end. */
  grow(capacity: number): void {
    const last = this.free[this.free.length - 1];
    if (last && last.start + last.size === this.capacity) last.size += capacity - this.capacity;
    else this.free.push({ start: this.capacity, size: capacity - this.capacity });
    this.capacity = capacity;
  }
  /** Highest used end, for the draw range. */
  get highWater(): number {
    const last = this.free[this.free.length - 1];
    return last && last.start + last.size === this.capacity ? last.start : this.capacity;
  }
}

/** One class's triangles: its own index buffer over the shared vertices. */
export interface PoolPart {
  readonly cls: number;
  readonly geometry: THREE.BufferGeometry;
}

interface Part extends PoolPart {
  index: THREE.BufferAttribute;
  indices: RunAllocator;
}

export class SkinPool {
  private readonly position: THREE.BufferAttribute;
  private readonly normal: THREE.BufferAttribute;
  private readonly anchor: THREE.BufferAttribute;
  private readonly piece: THREE.BufferAttribute;
  private readonly face: THREE.BufferAttribute;
  private readonly vertices: RunAllocator;
  private readonly partOf = new Map<number, Part>();
  private readonly runs = new Map<number, { v: number; vn: number; i: number; in: number; part: Part }>();
  /** Bumped when a class gets its first part, so the stage can draw it. */
  partsVersion = 0;

  /**
   * `indexBudget` is shared out between `classes` by `share` (any positive
   * weights); a class that outgrows its part doubles it.
   */
  constructor(
    readonly vertexCapacity: number, private readonly indexBudget: number,
    private readonly share: ReadonlyMap<number, number> = new Map(),
  ) {
    // NOT DynamicDrawUsage: three r182's WebGPU backend re-uploads a
    // dynamic attribute WHOLE every frame (Attributes.js), which for a pool
    // this size is gigabytes a second. Writes bump the version and name
    // their ranges instead, so only what changed is sent, once.
    const attr = (size: number) => new THREE.BufferAttribute(new Float32Array(vertexCapacity * size), size);
    this.position = attr(3);
    this.normal = attr(3);
    this.anchor = attr(4);
    this.piece = attr(1);
    this.face = attr(4);
    this.vertices = new RunAllocator(vertexCapacity);
  }

  /** Every class's part so far (the stage draws one mesh per part). */
  get parts(): PoolPart[] {
    return [...this.partOf.values()];
  }

  has(p: number): boolean {
    return this.runs.has(p);
  }

  get pieces(): number {
    return this.runs.size;
  }

  get verticesUsed(): number {
    return this.vertices.used;
  }

  private part(cls: number): Part {
    let part = this.partOf.get(cls);
    if (part) return part;
    let total = 0;
    for (const w of this.share.values()) total += w;
    const weight = this.share.get(cls) ?? 0;
    const capacity = Math.max(65536, Math.ceil(total > 0 ? (this.indexBudget * weight) / total : this.indexBudget / 8));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('normal', this.normal);
    geometry.setAttribute('cityAnchor', this.anchor);
    geometry.setAttribute('labPiece', this.piece);
    geometry.setAttribute('labFace', this.face);
    const index = new THREE.BufferAttribute(new Uint32Array(capacity), 1);
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    // Pieces move; the pool is drawn whole and never culled as one sphere.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    part = { cls, geometry, index, indices: new RunAllocator(capacity) };
    this.partOf.set(cls, part);
    this.partsVersion += 1;
    return part;
  }

  /** Double a part's index buffer (a new GPU buffer, uploaded whole once). */
  private grow(part: Part, atLeast: number): void {
    const capacity = Math.max(part.indices.capacity * 2, part.indices.capacity + atLeast);
    const array = new Uint32Array(capacity);
    array.set(part.index.array as Uint32Array);
    part.index = new THREE.BufferAttribute(array, 1);
    part.geometry.setIndex(part.index);
    part.indices.grow(capacity);
  }

  /** Write piece p's mesh; false when the pool has no room for it. */
  write(p: number, pieceDef: FracturePiece, mesh: PieceMesh, look: LabPieceLook): boolean {
    const vn = mesh.positions.length / 3;
    const inCount = mesh.indices.length;
    if (this.runs.has(p)) this.free(p);
    const v = this.vertices.allocate(vn);
    if (v < 0) return false;
    const part = this.part(pieceDef.cls);
    let i = part.indices.allocate(inCount);
    if (i < 0) {
      this.grow(part, inCount);
      i = part.indices.allocate(inCount);
    }
    const pos = this.position.array as Float32Array;
    const nrm = this.normal.array as Float32Array;
    const anc = this.anchor.array as Float32Array;
    const pc = this.piece.array as Float32Array;
    const fc = this.face.array as Float32Array;
    const c = pieceDef.centroid;
    const grain = pieceDef.grainAxis ?? 3;
    for (let k = 0; k < vn; k += 1) {
      const x = mesh.positions[k * 3];
      const y = mesh.positions[k * 3 + 1];
      const z = mesh.positions[k * 3 + 2];
      const o = v + k;
      pos[o * 3] = x;
      pos[o * 3 + 1] = y;
      pos[o * 3 + 2] = z;
      nrm[o * 3] = mesh.normals[k * 3];
      nrm[o * 3 + 1] = mesh.normals[k * 3 + 1];
      nrm[o * 3 + 2] = mesh.normals[k * 3 + 2];
      anc[o * 4] = x + c[0];
      anc[o * 4 + 1] = y + c[1];
      anc[o * 4 + 2] = z + c[2];
      anc[o * 4 + 3] = look.layerCode;
      pc[o] = p;
      fc[o * 4] = mesh.kinds[k] + 8 * grain;
      fc[o * 4 + 1] = pieceDef.cls;
      fc[o * 4 + 2] = mesh.relief[k];
      fc[o * 4 + 3] = mesh.sides[k];
    }
    const idx = part.index.array as Uint32Array;
    for (let k = 0; k < inCount; k += 1) idx[i + k] = v + mesh.indices[k];
    for (const [attribute, size] of [[this.position, 3], [this.normal, 3], [this.anchor, 4], [this.piece, 1], [this.face, 4]] as const) {
      attribute.addUpdateRange(v * size, vn * size);
      attribute.needsUpdate = true;
    }
    part.index.addUpdateRange(i, inCount);
    part.index.needsUpdate = true;
    this.runs.set(p, { v, vn, i, in: inCount, part });
    part.geometry.setDrawRange(0, part.indices.highWater);
    return true;
  }

  /** Release piece p's run: its triangles collapse to a point and vanish. */
  free(p: number): void {
    const run = this.runs.get(p);
    if (!run) return;
    const { part } = run;
    (part.index.array as Uint32Array).fill(0, run.i, run.i + run.in);
    part.index.addUpdateRange(run.i, run.in);
    part.index.needsUpdate = true;
    this.vertices.release(run.v, run.vn);
    part.indices.release(run.i, run.in);
    this.runs.delete(p);
    part.geometry.setDrawRange(0, part.indices.highWater);
  }

  dispose(): void {
    for (const part of this.partOf.values()) part.geometry.dispose();
  }
}
