// The static shell: the intact city drawn as one sub-draw per cell.
//
// A BatchedMesh submits one multi-draw sub-draw per instance, and per-instance
// is the whole point -- it is what lets a chunk tumble independently the frame
// its bond breaks. But measured on the M3 Max (ANGLE Metal, multi-draw
// NATIVE), each sub-draw costs ~1.3 us of GPU with the textured city shader,
// independent of pixels -- and the intact city was paying that for ~1,600
// chunks that had never moved and mostly never would. ~2 ms of an 8.33 ms
// budget, spent on the ability to move things that are not moving.
//
// So each cell's batch gets a SHELL: every member chunk's geometry merged into
// one static buffer at its rest pose, drawn as a single instance while the
// per-chunk instances sit hidden (a hidden BatchedMesh instance is compacted
// out of the indirect buffer entirely -- zero sub-draws). The first time a
// chunk actually moves, its triangles are knocked out of the shell and its
// individual instance un-hidden, in the same frame, at the same pose.
//
// The swap is pixel-identical by construction, not by hope:
//
//   - Shell positions are the chunk's `cityAnchor` values -- rest position
//     plus rest scale times local position -- which is exactly what the
//     instance matrix (compose of rest pose and scale) produces. Rest rotation
//     is identity everywhere (structures are stamped unrotated), so the rest
//     transform really is translation-and-scale, and baking it loses nothing.
//   - The triplanar mapping reads `cityAnchor`, which is copied through
//     verbatim, so the concrete cannot shift by a texel.
//   - Normals are copied unscaled. Under the instance path three transforms
//     them by the matrix and normalizes; scale is 1 for hulls and axis-aligned
//     for boxes, whose normals are axis-aligned -- normalize collapses both
//     paths to the same vector.
//
// A woken chunk never rejoins the shell. Chunks do migrate back to the intact
// body when an island retires, but at that point their pose IS the rest pose,
// so the individual instance renders exactly what the shell rendered; merging
// back would save one sub-draw at the cost of a re-upload and a class of
// reappearing-triangle bugs.

import * as THREE from 'three';

/** Index range of one chunk's triangles inside a shell, in absolute indices. */
export interface ShellRange {
  start: number;
  count: number;
}

/**
 * Accumulates member geometries into one rest-space buffer.
 *
 * Callers append each slot's geometry AFTER `bakeRestAnchors` has run on it,
 * because the anchor attribute is what carries the rest-space position this
 * merge is named for.
 */
export class ShellBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly anchors: number[] = [];
  private readonly indices: number[] = [];

  /** Append one chunk; returns where its triangles landed. */
  append(geometry: THREE.BufferGeometry): ShellRange {
    const anchor = geometry.getAttribute('cityAnchor');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    if (!index) throw new Error('shell members are always indexed (normalizeForBatching)');
    const vertexBase = this.positions.length / 3;
    for (let i = 0; i < anchor.count; i += 1) {
      // Anchor.xyz IS the rest-space vertex position; see the header.
      this.positions.push(anchor.getX(i), anchor.getY(i), anchor.getZ(i));
      this.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      this.anchors.push(anchor.getX(i), anchor.getY(i), anchor.getZ(i), anchor.getW(i));
    }
    const start = this.indices.length;
    for (let i = 0; i < index.count; i += 1) {
      this.indices.push(vertexBase + index.getX(i));
    }
    return { start, count: index.count };
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get indexCount(): number {
    return this.indices.length;
  }

  /**
   * The merged geometry, in the exact attribute layout `normalizeForBatching`
   * gives every other geometry entering a batch -- a mismatch is a hard error
   * that takes the whole mesh down.
   */
  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const vertexCount = this.vertexCount;
    geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(this.positions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(this.normals), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
    geometry.setAttribute('cityAnchor', new THREE.BufferAttribute(Float32Array.from(this.anchors), 4));
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(this.indices), 1));
    return geometry;
  }
}

/**
 * Remove one chunk's triangles from a live shell.
 *
 * The shell geometry must be the FIRST added to its BatchedMesh, so its index
 * range starts at absolute 0 and the ranges recorded by `append` need no
 * offset. Degenerate rather than compacted: every index in the range is set to
 * the range's own first vertex, which rasterises nothing, keeps every other
 * range's offsets valid, and uploads only this range.
 */
export function retireShellRange(mesh: THREE.BatchedMesh, range: ShellRange): void {
  const index = mesh.geometry.getIndex();
  if (!index) return;
  const array = index.array as Uint16Array | Uint32Array;
  const vertex = array[range.start];
  for (let i = 0; i < range.count; i += 1) {
    array[range.start + i] = vertex;
  }
  index.needsUpdate = true;
  index.addUpdateRange(range.start, range.count);
}
