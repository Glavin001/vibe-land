// The parts that broke off a car, drawn as what they are: rigid bodies of
// their own, at the world pose the physics gives each body.
//
// A body (a native fracture part) carries one or more visual parts at their
// authored offsets, so a loose visual part is drawn at
//   W = body pose * actor * part.matrix
// where `actor` is the car visual's own placement in the physics actor frame
// (VehicleVisual's actor-space group transform). W is computed once when a
// body's pose changes, never per frame.
//
// A loose part keeps its one instance in the car's batch (no extra draw call,
// never drawn twice), marked loose so the suspension no longer poses it
// (LiveAssembly.markLoose). How the batch draws a world matrix depends on it:
//   - the WebGPU part batch (vehicles/partBatchNodes.ts) takes it as is
//     (setWorldMatrixAt): its shader cancels the car's transform for loose
//     instances, so moving the car costs nothing;
//   - the WebGL InstancedMesh draws instances in the car's frame, so a loose
//     part is re-expressed there (inverse car world * W), and only on frames
//     the car moved or the body changed.

import * as THREE from 'three';

import type { LiveAssembly } from './dune/live-geometry.mjs';

export interface BodyPose {
  /** Native fracture part index (metadata.json parts[]). */
  part: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
}

/** A batch that draws world-space instances itself (the WebGPU part batch). */
interface WorldSpaceBatch {
  setWorldMatrixAt(index: number, matrix: THREE.Matrix4): void;
}
type Batch = THREE.InstancedMesh & Partial<WorldSpaceBatch>;

interface Loose {
  batch: Batch;
  index: number;
  /** Where the part is drawn, in world space. */
  world: THREE.Matrix4;
}

const ONE = new THREE.Vector3(1, 1, 1);

export class LooseParts {
  private readonly parts = new Map<string, Loose>();
  /** Parts whose world matrix changed and is not yet in their batch. */
  private readonly dirty = new Set<Loose>();
  /** The pose last drawn for each body, to skip bodies that did not move. */
  private readonly poses = new Map<number, Float64Array>();
  /** The car's world matrix when loose parts were last re-expressed in its frame (WebGL). */
  private readonly carWorld = new THREE.Matrix4();
  private carWorldKnown = false;
  private readonly body = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly toCar = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  constructor(private readonly assembly: LiveAssembly) {}

  get size(): number {
    return this.parts.size;
  }

  /**
   * Take the car's broken-off bodies (as the rig reports them): for each whose
   * pose changed, recompute its parts' world matrices. `groups` maps a body to
   * its visual part ids; `actor` and `partMatrix` place each part on it.
   */
  apply(bodies: readonly BodyPose[], groups: readonly string[][], actor: THREE.Matrix4, partMatrix: (id: string) => THREE.Matrix4 | undefined): void {
    for (const body of bodies) {
      const ids = groups[body.part];
      if (!ids?.length || this.unchanged(body)) continue;
      this.body.compose(this.position.fromArray(body.position), this.rotation.fromArray(body.rotation), ONE).multiply(actor);
      for (const id of ids) {
        const offset = partMatrix(id);
        const loose = offset && this.looseFor(id);
        if (!loose) continue;
        loose.world.multiplyMatrices(this.body, offset);
        this.dirty.add(loose);
      }
    }
  }

  /**
   * Write what changed into the batches. `car` is the object the batches
   * belong to (the car visual's group), for the WebGL batches that draw in its
   * frame. Cheap when nothing changed: call it every frame.
   */
  sync(car: THREE.Object3D): void {
    if (!this.parts.size) return;
    let carMoved = false;
    for (const loose of this.parts.values()) {
      if (!loose.batch.setWorldMatrixAt) {
        car.updateWorldMatrix(true, false);
        carMoved = !this.carWorldKnown || !this.carWorld.equals(car.matrixWorld);
        if (carMoved) {
          this.carWorld.copy(car.matrixWorld);
          this.carWorldKnown = true;
          this.toCar.copy(car.matrixWorld).invert();
        }
        break;
      }
    }
    const touched = new Set<Batch>();
    const write = (loose: Loose) => {
      if (loose.batch.setWorldMatrixAt) loose.batch.setWorldMatrixAt(loose.index, loose.world);
      else loose.batch.setMatrixAt(loose.index, this.local.multiplyMatrices(this.toCar, loose.world));
      touched.add(loose.batch);
    };
    if (carMoved) {
      for (const loose of this.parts.values()) if (!loose.batch.setWorldMatrixAt || this.dirty.has(loose)) write(loose);
    } else {
      for (const loose of this.dirty) write(loose);
    }
    this.dirty.clear();
    for (const batch of touched) batch.instanceMatrix.needsUpdate = true;
  }

  /** Every part back on the car (a respawn); `restore` gives its pose there. */
  reset(restore: (id: string) => THREE.Matrix4): void {
    for (const id of this.parts.keys()) this.assembly.restorePart(id, restore(id));
    this.discard();
  }

  /** Forget every loose part without touching the car (its model is being rebuilt). */
  discard(): void {
    this.parts.clear();
    this.dirty.clear();
    this.poses.clear();
    this.carWorldKnown = false;
  }

  /** Where each loose part is drawn, in world space (vehicle QA traces). */
  drawn(max: number): { id: string; position: [number, number, number]; center: [number, number, number]; rotation: [number, number, number, number] }[] {
    const out: { id: string; position: [number, number, number]; center: [number, number, number]; rotation: [number, number, number, number] }[] = [];
    const v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Vector3();
    for (const id of [...this.parts.keys()].sort().slice(0, max)) {
      const { batch, world } = this.parts.get(id)!;
      if (!batch.geometry.boundingSphere) batch.geometry.computeBoundingSphere();
      world.decompose(v, q, s);
      // A part's origin can sit far from its geometry (parts are authored in
      // the car's frame): `center` is where the geometry is drawn.
      c.copy(batch.geometry.boundingSphere!.center).applyMatrix4(world);
      out.push({ id, position: [v.x, v.y, v.z], center: [c.x, c.y, c.z], rotation: [q.x, q.y, q.z, q.w] });
    }
    return out;
  }

  /** True when `body` is where it was last drawn (and records it otherwise). */
  private unchanged(body: BodyPose): boolean {
    let last = this.poses.get(body.part);
    const same = !!last
      && last[0] === body.position[0] && last[1] === body.position[1] && last[2] === body.position[2]
      && last[3] === body.rotation[0] && last[4] === body.rotation[1] && last[5] === body.rotation[2] && last[6] === body.rotation[3];
    if (same) return true;
    if (!last) this.poses.set(body.part, last = new Float64Array(7));
    last.set(body.position, 0);
    last.set(body.rotation, 3);
    return false;
  }

  /** A part's loose state: on first use it leaves the car. */
  private looseFor(id: string): Loose | null {
    const existing = this.parts.get(id);
    if (existing) return existing;
    const slot = this.assembly.slots.get(id);
    if (!slot) return null;
    const loose = { batch: slot.mesh as Batch, index: slot.index, world: new THREE.Matrix4() };
    this.parts.set(id, loose);
    this.assembly.markLoose(id);
    return loose;
  }
}
