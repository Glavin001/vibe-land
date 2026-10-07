// The per-vertex frame a city chunk's Matter material is evaluated in
// (scene/cityMatterNodes.ts reads it): written on the CPU, once, when a cell
// that wears a Matter look is built.
//
// Coordinates are REST positions -- a shard keeps its pattern when it breaks
// off -- taken relative to an origin near the part, so FP32 still resolves a
// 0.1 mm steel groove: the building's for continuous materials (a concrete
// wall or a marble counter reads as one piece across its chunks), and a
// per-board log centre for wood (each board shows its own growth rings).
//
// The grain axis (oak's log, steel's brushing) is the chunk's longest rest
// axis unless the look names one.

import * as THREE from 'three';

import type { MatterAxis, ResolvedMatter } from '../graphics/matter/appearanceMatter';

export interface MatterCellSlot {
  slot: number;
  /** Where this slot's vertices start in the cell's merged geometry. */
  firstVertex: number;
  vertexCount: number;
  /** The unscaled prototype it was copied from (for its extents). */
  geometry: THREE.BufferGeometry;
}

export interface MatterFrameSource {
  /** Per slot: rest centre xyz, layer code w (cityChunkMesh.ts resolveShapes). */
  anchors: Float32Array;
  /** Per slot: render scale xyz (box extents, or 1 for hulls). */
  scales: Float32Array;
  /** Per slot: the slot naming its building. */
  buildingOfSlot: Int32Array;
}

/** The material's +Y as a rest axis: 0 = y, 1 = x, 2 = z (cityMatterNodes.ts toMaterial). */
export const AXIS_CODE = { y: 0, x: 1, z: 2 } as const;

/** Which rest axis the grain follows for a chunk with these extents. */
export function grainAxisCode(axis: MatterAxis, ex: number, ey: number, ez: number): number {
  if (axis !== 'long') return AXIS_CODE[axis];
  // Ties go to y (vertical), then x: a square panel stands its grain up.
  if (ey >= ex && ey >= ez) return AXIS_CODE.y;
  return ex >= ez ? AXIS_CODE.x : AXIS_CODE.z;
}

/** A small deterministic hash in [0, 1). */
function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const TMP_BOX = new THREE.Box3();
const TMP_SIZE = new THREE.Vector3();

/**
 * Write `matterFrame` (and, for steel, the brushing `tangent`, which the
 * vertex stage poses) onto a built cell.
 */
export function bakeMatterFrames(
  geometry: THREE.BufferGeometry,
  matter: ResolvedMatter,
  slots: MatterCellSlot[],
  source: MatterFrameSource,
): void {
  const anchor = geometry.getAttribute('cityAnchor') as THREE.BufferAttribute;
  const vertexCount = anchor.count;
  const frame = new Float32Array(vertexCount * 4);
  const wood = matter.recipe.kind === 'oak';
  for (const { slot, firstVertex, vertexCount: count, geometry: prototype } of slots) {
    prototype.boundingBox ?? prototype.computeBoundingBox();
    TMP_BOX.copy(prototype.boundingBox ?? TMP_BOX.makeEmpty()).getSize(TMP_SIZE);
    const ex = TMP_SIZE.x * source.scales[slot * 3];
    const ey = TMP_SIZE.y * source.scales[slot * 3 + 1];
    const ez = TMP_SIZE.z * source.scales[slot * 3 + 2];
    const code = grainAxisCode(matter.axis, ex, ey, ez);

    let ox: number;
    let oy: number;
    let oz: number;
    if (wood) {
      // The board's own log: its axis along the grain, 12-27 cm off the
      // board's centre, at a random height, so neighbouring boards show
      // different rings and the odd cathedral.
      const radius = 0.12 + 0.15 * hash01(slot, 1);
      const angle = 2 * Math.PI * hash01(slot, 2);
      const along = 2 * hash01(slot, 3) - 1;
      const a = radius * Math.cos(angle);
      const b = radius * Math.sin(angle);
      // Offsets in rest axes: `along` on the grain axis, (a, b) across it.
      const off = code === AXIS_CODE.y ? [a, along, b] : code === AXIS_CODE.x ? [along, a, b] : [a, b, along];
      ox = source.anchors[slot * 4] - off[0];
      oy = source.anchors[slot * 4 + 1] - off[1];
      oz = source.anchors[slot * 4 + 2] - off[2];
    } else {
      // One continuous volume per building, from a whole-metre origin.
      const root = source.buildingOfSlot[slot];
      ox = Math.round(source.anchors[root * 4]);
      oy = Math.round(source.anchors[root * 4 + 1]);
      oz = Math.round(source.anchors[root * 4 + 2]);
    }
    for (let v = firstVertex; v < firstVertex + count; v += 1) {
      frame[v * 4] = anchor.getX(v) - ox;
      frame[v * 4 + 1] = anchor.getY(v) - oy;
      frame[v * 4 + 2] = anchor.getZ(v) - oz;
      frame[v * 4 + 3] = code;
    }
  }
  geometry.setAttribute('matterFrame', new THREE.BufferAttribute(frame, 4));
  if (matter.recipe.kind === 'steel') geometry.setAttribute('tangent', brushingTangents(geometry, frame));
}

/** Rest -> material axes (cityMatterNodes.ts toMaterial). */
function toMaterial(code: number, v: [number, number, number]): [number, number, number] {
  if (code === AXIS_CODE.x) return [-v[1], v[0], v[2]];
  if (code === AXIS_CODE.z) return [v[0], v[2], -v[1]];
  return v;
}

/** Material -> rest axes (cityMatterNodes.ts toRest). */
function toRest(code: number, m: [number, number, number]): [number, number, number] {
  if (code === AXIS_CODE.x) return [m[1], -m[0], m[2]];
  if (code === AXIS_CODE.z) return [m[0], -m[2], m[1]];
  return m;
}

/**
 * Steel's anisotropy tangent in the rest frame: across the brushing, as the
 * lab's manufacturing tangents (shapes.ts setManufacturingTangents) are in
 * object space. The vertex stage poses it with the chunk.
 */
function brushingTangents(geometry: THREE.BufferGeometry, frame: Float32Array): THREE.BufferAttribute {
  const normal = geometry.getAttribute('normal');
  const out = new Float32Array(normal.count * 4);
  for (let v = 0; v < normal.count; v += 1) {
    const code = frame[v * 4 + 3];
    const n = toMaterial(code, [normal.getX(v), normal.getY(v), normal.getZ(v)]);
    // cross(n, up), up = +Y unless the face is nearly flat, then +Z.
    const up = Math.abs(n[1]) < 0.98 ? [0, 1, 0] : [0, 0, 1];
    let t: [number, number, number] = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]];
    const len = Math.hypot(t[0], t[1], t[2]) || 1;
    t = toRest(code, [t[0] / len, t[1] / len, t[2] / len]);
    out[v * 4] = t[0];
    out[v * 4 + 1] = t[1];
    out[v * 4 + 2] = t[2];
    out[v * 4 + 3] = 1;
  }
  return new THREE.BufferAttribute(out, 4);
}
