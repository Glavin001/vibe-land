// Getting each chunk's REST pose to the shader, once per render path.
//
// The triplanar mapping in cityMaterialShader is anchored to where a chunk was
// BUILT, not where it currently is -- that is what makes it survive a building
// coming apart. This module is the plumbing for that one number, and it is the
// only place the instanced and batched paths genuinely disagree.
//
// They disagree because BatchedMesh has no per-instance attribute channel at
// all. Its per-instance state (matrix, colour) lives in data textures three
// owns, and adding our own would mean a uniform -- which is per MATERIAL, so
// every batch would need its own material. That is not just extra objects: the
// opaque render list sorts by material id BEFORE z, so splitting the city's one
// material into hundreds would replace front-to-back traversal with build
// order and hand the fill-bound tier a pile of overdraw it does not currently
// pay. Baking the anchor into each instance's own vertices avoids all of it.
//
// The cost is vertex memory in the hull batches, bounded by how often a shape
// repeats inside one 32 m cell -- and a shape used more than a handful of times
// city-wide is claimed by the shared-shape instanced path instead, so the bound
// is small. Packs with no shape library pay nothing at all.

import * as THREE from 'three';

/**
 * Per-instance rest pose for an InstancedMesh, in instance-id order.
 *
 * `slots[i]` must be the slot seated at instance `i`; both callers build their
 * instance ids as positions in this same list.
 *
 * The rest scale is carried explicitly rather than recovered from the instance
 * matrix's columns, for two reasons: `cityChunkWrite` collapses a hidden
 * chunk's scale to zero, which would both NaN the reconstruction and untether
 * the texture from a chunk that later comes back; and reading it here is three
 * array loads instead of three per-vertex square roots.
 */
export function attachInstanceAnchors(
  mesh: THREE.InstancedMesh,
  slots: readonly number[],
  anchors: Float32Array,
  scales: Float32Array,
): void {
  const anchor = new Float32Array(slots.length * 4);
  const restScale = new Float32Array(slots.length * 3);
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    anchor[i * 4] = anchors[slot * 4];
    anchor[i * 4 + 1] = anchors[slot * 4 + 1];
    anchor[i * 4 + 2] = anchors[slot * 4 + 2];
    anchor[i * 4 + 3] = anchors[slot * 4 + 3];
    restScale[i * 3] = scales[slot * 3];
    restScale[i * 3 + 1] = scales[slot * 3 + 1];
    restScale[i * 3 + 2] = scales[slot * 3 + 2];
  }
  // Exactly mesh.count long, deliberately. three does not validate an instanced
  // attribute's length against the draw count -- it just draws, and the short
  // tail reads back as zeros, which anchors those chunks at the world origin
  // and looks like one oddly-textured block rather than like a bug.
  mesh.geometry.setAttribute('cityAnchor', new THREE.InstancedBufferAttribute(anchor, 4));
  mesh.geometry.setAttribute('cityRestScale', new THREE.InstancedBufferAttribute(restScale, 3));
}

/**
 * Write one slot's absolute rest-space vertex positions into a shape prototype.
 *
 * Called immediately before `BatchedMesh.addGeometry`, which COPIES the vertex
 * data into the batch's own buffers -- so one mutable prototype per shape
 * serves every instance of it, and no per-instance geometry is allocated.
 *
 * The result is absolute rather than an origin plus an offset, which is why the
 * batched branch of the shader carries no scale term.
 */
export function bakeRestAnchors(
  geometry: THREE.BufferGeometry,
  slot: number,
  anchors: Float32Array,
  scales: Float32Array,
): void {
  const position = geometry.getAttribute('position');
  const target = geometry.getAttribute('cityAnchor') as THREE.BufferAttribute;
  const out = target.array as Float32Array;
  const ox = anchors[slot * 4];
  const oy = anchors[slot * 4 + 1];
  const oz = anchors[slot * 4 + 2];
  const layer = anchors[slot * 4 + 3];
  const sx = scales[slot * 3];
  const sy = scales[slot * 3 + 1];
  const sz = scales[slot * 3 + 2];
  for (let i = 0; i < position.count; i += 1) {
    out[i * 4] = ox + sx * position.getX(i);
    out[i * 4 + 1] = oy + sy * position.getY(i);
    out[i * 4 + 2] = oz + sz * position.getZ(i);
    out[i * 4 + 3] = layer;
  }
  target.needsUpdate = true;
}
