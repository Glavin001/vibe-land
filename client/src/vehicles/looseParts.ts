// The parts that broke off a car, drawn as what they are: rigid bodies of
// their own, in world space, at the pose the physics gives each body.
//
// A body (a native fracture part) carries one or more visual parts at their
// authored offsets, so a visual part's world matrix is
//   body pose * actor * part.matrix
// where `actor` is the car visual's own placement in the physics actor frame
// (VehicleVisual's actor-space group transform). That is written once when a
// body's pose changes, never per frame and never through the car's pose: a
// piece at rest costs nothing however the car moves.
//
// Each loose part has one instance, here; its instance on the car is hidden
// (LiveAssembly.hidePart), so no part is ever drawn twice. The batches mirror
// the car's (same geometry and material), so they share its shaders.

import * as THREE from 'three';

import { createPartBatchMesh, type LiveAssembly } from './dune/live-geometry.mjs';

export interface BodyPose {
  /** Native fracture part index (metadata.json parts[]). */
  part: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
}

type Batch = THREE.InstancedMesh;

const ONE = new THREE.Vector3(1, 1, 1);

export class LooseParts {
  /** World-space container: the caller places it beside the car, not under it. */
  readonly group = new THREE.Group();
  /** One batch per car batch that has lost a part. */
  private readonly batches = new Map<THREE.Object3D, Batch>();
  /** Instances in use per batch. Kept here: the WebGPU part batch reads its
   * `count` as 1 (vehicles/partBatchNodes.ts), so it cannot be the cursor. */
  private readonly used = new Map<Batch, number>();
  /** Loose visual part id -> its instance. */
  private readonly slots = new Map<string, { batch: Batch; index: number }>();
  /** The pose last drawn for each body, to skip bodies that did not move. */
  private readonly poses = new Map<number, Float64Array>();
  private readonly body = new THREE.Matrix4();
  private readonly instance = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();

  constructor(private readonly assembly: LiveAssembly) {
    this.group.name = 'loose vehicle parts';
  }

  get size(): number {
    return this.slots.size;
  }

  /**
   * Draw `bodies` (the car's broken-off bodies, as the rig reports them):
   * for each whose pose changed, write its parts' instances. `groups` maps a
   * body to its visual part ids; `actor` and `partMatrix` place each part.
   */
  apply(bodies: readonly BodyPose[], groups: readonly string[][], actor: THREE.Matrix4, partMatrix: (id: string) => THREE.Matrix4 | undefined): void {
    const touched = new Set<Batch>();
    for (const body of bodies) {
      const ids = groups[body.part];
      if (!ids?.length || this.unchanged(body)) continue;
      this.body.compose(this.position.fromArray(body.position), this.rotation.fromArray(body.rotation), ONE).multiply(actor);
      for (const id of ids) {
        const local = partMatrix(id);
        const slot = local && this.slotFor(id);
        if (!slot) continue;
        slot.batch.setMatrixAt(slot.index, this.instance.multiplyMatrices(this.body, local));
        touched.add(slot.batch);
      }
    }
    for (const batch of touched) batch.instanceMatrix.needsUpdate = true;
  }

  /** Every part back on the car (a respawn); `restore` gives its pose there. */
  reset(restore: (id: string) => THREE.Matrix4): void {
    for (const id of this.slots.keys()) this.assembly.showPart(id, restore(id));
    this.slots.clear();
    this.poses.clear();
    for (const batch of this.batches.values()) {
      batch.count = 0;
      this.used.set(batch, 0);
    }
  }

  /** Where each loose part is drawn, in world space (vehicle QA traces). */
  drawn(max: number): { id: string; position: [number, number, number]; center: [number, number, number]; rotation: [number, number, number, number] }[] {
    const out: { id: string; position: [number, number, number]; center: [number, number, number]; rotation: [number, number, number, number] }[] = [];
    const m = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), c = new THREE.Vector3();
    this.group.updateWorldMatrix(true, false);
    for (const id of [...this.slots.keys()].sort().slice(0, max)) {
      const { batch, index } = this.slots.get(id)!;
      if (!batch.geometry.boundingSphere) batch.geometry.computeBoundingSphere();
      batch.getMatrixAt(index, m);
      m.premultiply(this.group.matrixWorld).decompose(v, q, s);
      // A part's origin can sit far from its geometry (parts are authored in
      // the car's frame): `center` is where the geometry is drawn.
      c.copy(batch.geometry.boundingSphere!.center).applyMatrix4(m);
      out.push({ id, position: [v.x, v.y, v.z], center: [c.x, c.y, c.z], rotation: [q.x, q.y, q.z, q.w] });
    }
    return out;
  }

  /** Drop every loose part without touching the car (its model is being rebuilt). */
  discard(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch);
      batch.dispose();
    }
    this.batches.clear();
    this.used.clear();
    this.slots.clear();
    this.poses.clear();
  }

  dispose(): void {
    this.discard();
    this.group.removeFromParent();
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

  /** A loose part's instance: on first use the part leaves the car. */
  private slotFor(id: string): { batch: Batch; index: number } | null {
    const existing = this.slots.get(id);
    if (existing) return existing;
    const onCar = this.assembly.slots.get(id);
    if (!onCar) return null;
    let batch = this.batches.get(onCar.mesh);
    if (!batch) {
      const parts = onCar.mesh.userData.parts as unknown[];
      batch = createPartBatchMesh(onCar.part.geometry, onCar.mesh.material, parts.length) as Batch;
      batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      batch.castShadow = batch.receiveShadow = true;
      // The bodies are anywhere: no aggregate bounds to cull by.
      batch.frustumCulled = false;
      batch.count = 0;
      this.used.set(batch, 0);
      batch.userData = { system: onCar.mesh.userData.system, material: onCar.mesh.userData.material, parts: [] as { id: string }[] };
      this.batches.set(onCar.mesh, batch);
      this.group.add(batch);
    }
    const index = this.used.get(batch) ?? 0;
    this.used.set(batch, index + 1);
    batch.count = index + 1;
    (batch.userData.parts as { id: string }[])[index] = onCar.part;
    const slot = { batch, index };
    this.slots.set(id, slot);
    this.assembly.hidePart(id);
    return slot;
  }
}
