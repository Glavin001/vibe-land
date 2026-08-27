// Writing one chunk's transform into whichever object draws it.
//
// Shared by the mesh builder (seating rest poses) and the frame loop (the
// per-frame dirty write), which is why it lives apart from both. It is the last
// point every chunk transform passes through, so it also carries the teleport
// probe: a jump seen here is a jump the player saw, whatever produced it
// upstream.

import * as THREE from 'three';

import type { CityClient } from '../city/cityClient';
import type { LedgerBody } from '../city/topology';
import { renderStats } from '../city/renderStats';

const TMP_MATRIX = new THREE.Matrix4();
const TMP_POSITION = new THREE.Vector3();
const TMP_QUATERNION = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();

/**
 * One drawable object. A cell yields an InstancedMesh for its boxes, a
 * BatchedMesh for its one-off hulls, or both; a widely-shared shape yields a
 * city-wide InstancedMesh of its own.
 *
 * Kept behind one union so the write path, the teardown and the sphere
 * recompute branch once per object rather than once per chunk. The two classes
 * agree on `setMatrixAt`/`setColorAt`/`getMatrixAt`/`computeBoundingSphere`;
 * they differ on hiding and on upload bookkeeping, and those are the only two
 * places the `kind` is read.
 */
export type CityRenderable =
  | { kind: 'batched'; mesh: THREE.BatchedMesh }
  | { kind: 'instanced'; mesh: THREE.InstancedMesh };

/**
 * Depth below which a chunk cannot be poking through the flat y=0 ground no
 * matter its size or orientation, so drawing it is pure waste.
 *
 * Deliberately far below CHUNK_SUNK_Y_M (-0.25): that constant flags a chunk as
 * *suspicious* for the below-ground diagnostic, where a large slab's centroid
 * can legitimately sit slightly negative while its top face shows. Hiding must
 * be conservative the other way -- the largest authored chunks are a few metres
 * across, so at -4 m the whole body is underground. Tunnelled chunks have been
 * observed at -74 m, each still costing a draw.
 */
const CHUNK_HIDE_Y_M = -4;

/**
 * Consecutive writes a chunk must read below the threshold before it is hidden.
 *
 * Hiding is a cull for chunks that have genuinely escaped the world, and those
 * stay escaped -- so waiting costs nothing real. Acting on a SINGLE frame does
 * cost something: one bad pose blanks the geometry instantly, which is visible
 * as a hole opening in a building mid-fracture and closing again. And a chunk
 * hidden on a blip could stay hidden, because the hidden path used to skip its
 * matrix write entirely, so nothing corrected it once it stopped being drawn.
 */
const CHUNK_HIDE_STREAK = 8;

/**
 * Scratch for one composed chunk pose (x,y,z, qx,qy,qz,qw).
 *
 * Module-level so the write path allocates nothing per chunk: the allocating
 * compose built seven arrays and an object per chunk, which at thousands of
 * dirty chunks a frame was the layer's largest source of garbage.
 */
const TMP_POSE = new Float32Array(7);
/** `chunkTeleportProbe` wants a Vec3; only built while recording. */
const TMP_PROBE_POS: [number, number, number] = [0, 0, 0];

/** Per-write context so a teleport event names its suspect, not just a slot. */
export interface ChunkWriteContext {
  bodyKey: number;
  settling: boolean;
  bodySettled: boolean;
  /** Ledger pose source at write time — splits decoder jumps from compose jumps. */
  source?: string;
}

/** Set while recording; see `setChunkTeleportProbe`. */
let chunkTeleportProbe:
  | ((slot: number, position: readonly number[], ctx?: ChunkWriteContext) => void)
  | null = null;

export function setChunkTeleportProbe(
  probe: ((slot: number, position: readonly number[], ctx?: ChunkWriteContext) => void) | null,
): void {
  chunkTeleportProbe = probe;
}

export function writeInstance(
  renderable: CityRenderable,
  client: CityClient,
  slot: number,
  body: LedgerBody | undefined,
  scales: Float32Array,
  instanceIds: Int32Array,
  hiddenBySlot?: Uint8Array,
  belowStreakBySlot?: Uint8Array,
  probeCtx?: ChunkWriteContext,
): void {
  const instanceId = instanceIds[slot];
  if (instanceId < 0) {
    return;
  }
  if (!client.topology.chunkWorldPoseInto(slot, body, TMP_POSE, 0)) {
    // The ledger cannot resolve this chunk's body right now -- a migration
    // naming an island whose promotion has not been applied yet, or a retire
    // that outran its replacement. It has no known world pose, so the only
    // correct thing to draw is what is already on screen. Writing the
    // body-local offset instead would teleport it to near the world origin for
    // as long as the gap lasts, which reads as a hole in the building.
    renderStats.chunksUnresolved += 1;
    return;
  }
  if (chunkTeleportProbe) {
    TMP_PROBE_POS[0] = TMP_POSE[0];
    TMP_PROBE_POS[1] = TMP_POSE[1];
    TMP_PROBE_POS[2] = TMP_POSE[2];
    chunkTeleportProbe(slot, TMP_PROBE_POS, probeCtx);
  }
  let hidden = false;
  if (hiddenBySlot && belowStreakBySlot) {
    const below = TMP_POSE[1] < CHUNK_HIDE_Y_M;
    const streak = below ? Math.min(255, belowStreakBySlot[slot] + 1) : 0;
    belowStreakBySlot[slot] = streak;
    const hide = streak >= CHUNK_HIDE_STREAK;
    if (hide !== (hiddenBySlot[slot] === 1)) {
      if (renderable.kind === 'batched') renderable.mesh.setVisibleAt(instanceId, !hide);
      hiddenBySlot[slot] = hide ? 1 : 0;
      if (hide) renderStats.chunksHidden += 1;
    }
    hidden = hide;
    // The matrix is written either way. Skipping it while hidden saved a
    // compose and cost correctness: a chunk that settled while hidden kept
    // whatever pose it had when it vanished, so un-hiding drew it in the wrong
    // place -- or never, since a settled body stops being dirty.
  }
  TMP_POSITION.set(TMP_POSE[0], TMP_POSE[1], TMP_POSE[2]);
  TMP_QUATERNION.set(TMP_POSE[3], TMP_POSE[4], TMP_POSE[5], TMP_POSE[6]);
  if (hidden && renderable.kind === 'instanced') {
    // An InstancedMesh has no per-instance visibility flag -- every instance in
    // the buffer is drawn. A zero scale collapses the shape to a point, which
    // rasterises nothing; the vertex shader still runs for its vertices, which
    // is the whole cost and is far below what a sub-draw would have been.
    //
    // The real pose is still composed above and the position still written, so
    // the invariant the batched path documents holds here too: a chunk that
    // settles while hidden un-hides in the right place.
    TMP_SCALE.set(0, 0, 0);
  } else {
    TMP_SCALE.set(scales[slot * 3], scales[slot * 3 + 1], scales[slot * 3 + 2]);
  }
  TMP_MATRIX.compose(TMP_POSITION, TMP_QUATERNION, TMP_SCALE);
  renderable.mesh.setMatrixAt(instanceId, TMP_MATRIX);
}
