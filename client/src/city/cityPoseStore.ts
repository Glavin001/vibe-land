// Where the city's chunks are drawn: the chunk records and body poses the GPU
// composes, and the per-frame step that keeps them true.
//
// Split out of citySlotMesh.ts / cityChunkMesh.ts / CityChunksLayer.tsx so the
// render layer and Netlab v2's headless client stage (client/netlab/v2) run
// the SAME code up to the numbers the vertex shader reads -- nothing here
// touches three.js or the DOM. The layer adds the textures, the meshes and its
// instrumentation around it; Netlab adds only a recorder of what changed.
//
// A chunk's drawn pose is `body_pose ∘ local_offset`, composed in the vertex
// shader (citySlotMesh.ts `citySlotMatrix`) from two tables:
//
//   chunk records  one per slot: [bodyIndex, lx, ly, lz] [qx, qy, qz, qw]
//   body poses     one per body index: [px, py, pz, tint] [qx, qy, qz, qw] [r, g, b, -] [-]
//
// `chunkWorldPoseInto` below is that composition on the CPU, term for term,
// including the shader's hide rule (a composed centre below CHUNK_HIDE_Y_M, or
// a slot with no record yet, is collapsed to a point: not drawn).

import type { CityClient } from './cityClient';
import type { LedgerBody } from './topology';
import type { Vec3 } from './vec';

/**
 * Depth below which a chunk cannot be poking through the flat y=0 ground no
 * matter its size or orientation, so drawing it is pure waste.
 */
export const CHUNK_HIDE_Y_M = -4;

export const FLOATS_PER_BODY = 16;
export const FLOATS_PER_CHUNK = 8;
export const INITIAL_BODY_CAPACITY = 4096;

/** Colour for a body pose write; the debug palette, or null for white. */
export interface BodyColour {
  r: number;
  g: number;
  b: number;
}

/** What a recorder learns from `drainChanges` (opt-in; see `trackChanges`). */
export interface PoseStoreChanges {
  /** Body indices written since the last drain, each once. */
  bodies: number[];
  /** Slots whose record was written since the last drain, each once. */
  slots: number[];
}

/**
 * The two tables and the bookkeeping that keeps them true.
 *
 * Body indices are handed out as bodies are first written and given back only
 * once the body is gone AND no chunk record points at it any more, so a stale
 * record (a chunk orphaned by a retire, drawn at its last pose until it is
 * adopted) can never be read against some other body that inherited the
 * index.
 */
export class CityPoseStore {
  readonly chunkCount: number;
  readonly chunkData: Float32Array;
  bodyData: Float32Array;
  bodyCapacity: number;
  /** Slot -> body index its record names, or -1 before its first record. */
  readonly bodyIndexOfSlot: Int32Array;
  /** Slot -> |local offset| + chunk radius: how far a chunk can be from its body's origin. */
  readonly reachOfSlot: Float32Array;
  private readonly indexOfBody = new Map<number, number>();
  /** Index -> the body key last given it (kept after release: stale records still read it). */
  private readonly bodyOfIndex: number[] = [];
  private readonly lastKeyOfIndex: number[] = [];
  private readonly recordsOnIndex: number[] = [];
  private readonly freeIndices: number[] = [];
  /** Indices whose body is gone; released once their record count reaches zero. */
  private readonly retiringIndices = new Set<number>();
  private nextIndex = 0;
  protected chunkDirty = false;
  protected bodyDirty = false;
  private changes: { bodyFlags: Uint8Array; slotFlags: Uint8Array; bodies: number[]; slots: number[] } | null = null;

  /**
   * `chunkData` and `bodyData` may be larger than needed (the GPU subclass
   * hands in texture-backed arrays); they are only ever indexed by slot and
   * body index.
   */
  constructor(
    chunkCount: number,
    radii: ArrayLike<number>,
    chunkData: Float32Array = new Float32Array(chunkCount * FLOATS_PER_CHUNK),
    bodyData: Float32Array = new Float32Array(INITIAL_BODY_CAPACITY * FLOATS_PER_BODY),
    bodyCapacity = INITIAL_BODY_CAPACITY,
  ) {
    this.chunkCount = chunkCount;
    this.chunkData = chunkData;
    this.bodyData = bodyData;
    this.bodyCapacity = bodyCapacity;
    this.bodyIndexOfSlot = new Int32Array(chunkCount).fill(-1);
    this.reachOfSlot = new Float32Array(chunkCount);
    for (let slot = 0; slot < chunkCount; slot += 1) this.reachOfSlot[slot] = radii[slot] ?? 0;
  }

  /** A larger body table, at least `capacity` bodies; the GPU subclass backs it with a texture. */
  protected allocateBodies(capacity: number): Float32Array {
    return new Float32Array(capacity * FLOATS_PER_BODY);
  }

  /** Called after the body table was replaced by a larger one. */
  protected bodiesGrown(): void {}

  /**
   * Record which indices and slots are written, for a recorder that replays
   * the tables elsewhere (Netlab). Off by default: nothing drains it live.
   */
  trackChanges(): void {
    if (this.changes) return;
    this.changes = {
      bodyFlags: new Uint8Array(this.bodyCapacity),
      slotFlags: new Uint8Array(this.chunkCount),
      bodies: [],
      slots: [],
    };
  }

  drainChanges(): PoseStoreChanges {
    const changes = this.changes;
    if (!changes) return { bodies: [], slots: [] };
    for (const index of changes.bodies) changes.bodyFlags[index] = 0;
    for (const slot of changes.slots) changes.slotFlags[slot] = 0;
    const out = { bodies: changes.bodies, slots: changes.slots };
    changes.bodies = [];
    changes.slots = [];
    return out;
  }

  /** The index a body writes at, allocating on first sight. */
  bodyIndexFor(key: number): number {
    const existing = this.indexOfBody.get(key);
    if (existing !== undefined) return existing;
    let index: number;
    if (this.freeIndices.length > 0) {
      index = this.freeIndices.pop()!;
    } else {
      index = this.nextIndex;
      this.nextIndex += 1;
      if (index >= this.bodyCapacity) this.growBodies();
    }
    this.indexOfBody.set(key, index);
    this.bodyOfIndex[index] = key;
    this.lastKeyOfIndex[index] = key;
    this.recordsOnIndex[index] = this.recordsOnIndex[index] ?? 0;
    return index;
  }

  hasBody(key: number): boolean {
    return this.indexOfBody.has(key);
  }

  /** The body key the index was last given (also after that body was released); -1 if never. */
  keyOfIndex(index: number): number {
    return this.lastKeyOfIndex[index] ?? -1;
  }

  private growBodies(): void {
    const capacity = this.bodyCapacity * 2;
    const grown = this.allocateBodies(capacity);
    grown.set(this.bodyData.subarray(0, this.bodyCapacity * FLOATS_PER_BODY));
    this.bodyData = grown;
    this.bodyCapacity = capacity;
    this.bodyDirty = true;
    if (this.changes) {
      const flags = new Uint8Array(capacity);
      flags.set(this.changes.bodyFlags);
      this.changes.bodyFlags = flags;
    }
    this.bodiesGrown();
  }

  /**
   * A body the ledger no longer has. Its index is reused only once no chunk
   * record names it.
   */
  releaseBody(key: number): void {
    const index = this.indexOfBody.get(key);
    if (index === undefined) return;
    this.indexOfBody.delete(key);
    this.bodyOfIndex[index] = -1;
    if ((this.recordsOnIndex[index] ?? 0) > 0) this.retiringIndices.add(index);
    else this.freeIndices.push(index);
  }

  writeBody(
    index: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    tint: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const at = index * FLOATS_PER_BODY;
    const data = this.bodyData;
    data[at] = position[0];
    data[at + 1] = position[1];
    data[at + 2] = position[2];
    data[at + 3] = tint;
    data[at + 4] = rotation[0];
    data[at + 5] = rotation[1];
    data[at + 6] = rotation[2];
    data[at + 7] = rotation[3];
    data[at + 8] = r;
    data[at + 9] = g;
    data[at + 10] = b;
    data[at + 11] = 0;
    this.bodyDirty = true;
    const changes = this.changes;
    if (changes && changes.bodyFlags[index] === 0) {
      changes.bodyFlags[index] = 1;
      changes.bodies.push(index);
    }
  }

  /** Where the body at `index` was last written, for the sphere refresh. */
  bodyPositionAt(index: number, out: Float32Array): void {
    const at = index * FLOATS_PER_BODY;
    out[0] = this.bodyData[at];
    out[1] = this.bodyData[at + 1];
    out[2] = this.bodyData[at + 2];
  }

  writeChunk(
    slot: number,
    bodyIndex: number,
    local: ArrayLike<number>,
    localRot: ArrayLike<number>,
    radius: number,
  ): void {
    const previous = this.bodyIndexOfSlot[slot];
    if (previous !== bodyIndex) {
      if (previous >= 0) {
        this.recordsOnIndex[previous] -= 1;
        if (this.recordsOnIndex[previous] === 0 && this.retiringIndices.has(previous)) {
          this.retiringIndices.delete(previous);
          this.freeIndices.push(previous);
        }
      }
      this.recordsOnIndex[bodyIndex] = (this.recordsOnIndex[bodyIndex] ?? 0) + 1;
      this.bodyIndexOfSlot[slot] = bodyIndex;
    }
    const at = slot * FLOATS_PER_CHUNK;
    const data = this.chunkData;
    data[at] = bodyIndex;
    data[at + 1] = local[0];
    data[at + 2] = local[1];
    data[at + 3] = local[2];
    data[at + 4] = localRot[0];
    data[at + 5] = localRot[1];
    data[at + 6] = localRot[2];
    data[at + 7] = localRot[3];
    this.reachOfSlot[slot] = Math.sqrt(local[0] * local[0] + local[1] * local[1] + local[2] * local[2]) + radius;
    this.chunkDirty = true;
    const changes = this.changes;
    if (changes && changes.slotFlags[slot] === 0) {
      changes.slotFlags[slot] = 1;
      changes.slots.push(slot);
    }
  }

  /**
   * Stop drawing a chunk: its record names no body (index -1), which the
   * shader collapses to a point. For a chunk the server retired -- it is gone,
   * and its last pose is not somewhere it is.
   */
  hideChunk(slot: number): void {
    const previous = this.bodyIndexOfSlot[slot];
    if (previous < 0) return;
    this.recordsOnIndex[previous] -= 1;
    if (this.recordsOnIndex[previous] === 0 && this.retiringIndices.has(previous)) {
      this.retiringIndices.delete(previous);
      this.freeIndices.push(previous);
    }
    this.bodyIndexOfSlot[slot] = -1;
    this.chunkData[slot * FLOATS_PER_CHUNK] = -1;
    this.chunkDirty = true;
    const changes = this.changes;
    if (changes && changes.slotFlags[slot] === 0) {
      changes.slotFlags[slot] = 1;
      changes.slots.push(slot);
    }
  }

  /** Composes one chunk's drawn centre on the CPU, exactly as the shader does. */
  chunkWorldPositionInto(slot: number, out: Float32Array, at = 0): boolean {
    const index = this.bodyIndexOfSlot[slot];
    if (index < 0) return false;
    const c = slot * FLOATS_PER_CHUNK;
    const b = index * FLOATS_PER_BODY;
    return composeChunkPosition(this.bodyData, b, this.chunkData, c, out, at);
  }

  /**
   * One chunk's drawn pose, as the vertex shader composes it: 7 floats
   * (x, y, z, qx, qy, qz, qw) at `out[at..]`. Returns false when the shader
   * draws nothing for it (no record yet, or composed below CHUNK_HIDE_Y_M);
   * `out` still holds the composed pose then, when there is one.
   */
  chunkWorldPoseInto(slot: number, out: Float32Array, at = 0): boolean {
    const index = this.bodyIndexOfSlot[slot];
    if (index < 0) return false;
    const c = slot * FLOATS_PER_CHUNK;
    const b = index * FLOATS_PER_BODY;
    composeChunkPosition(this.bodyData, b, this.chunkData, c, out, at);
    composeChunkRotation(this.bodyData, b, this.chunkData, c, out, at + 3);
    return !(out[at + 1] < CHUNK_HIDE_Y_M);
  }

  /** Flag whatever changed for upload. Once per frame, after all writes. */
  upload(): void {
    this.chunkDirty = false;
    this.bodyDirty = false;
  }
}

/** `p = body.xyz + rotate(body.q, record.local)` (citySlotMatrix). */
export function composeChunkPosition(
  bodyData: ArrayLike<number>,
  b: number,
  chunkData: ArrayLike<number>,
  c: number,
  out: Float32Array | number[],
  at = 0,
): boolean {
  const lx = chunkData[c + 1];
  const ly = chunkData[c + 2];
  const lz = chunkData[c + 3];
  const qx = bodyData[b + 4];
  const qy = bodyData[b + 5];
  const qz = bodyData[b + 6];
  const qw = bodyData[b + 7];
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const cx = qy * lz - qz * ly + qw * lx;
  const cy = qz * lx - qx * lz + qw * ly;
  const cz = qx * ly - qy * lx + qw * lz;
  out[at] = bodyData[b] + lx + 2 * (qy * cz - qz * cy);
  out[at + 1] = bodyData[b + 1] + ly + 2 * (qz * cx - qx * cz);
  out[at + 2] = bodyData[b + 2] + lz + 2 * (qx * cy - qy * cx);
  return true;
}

/** `q = normalize(body.q * record.q)` (citySlotMatrix's cityQuatMul). */
export function composeChunkRotation(
  bodyData: ArrayLike<number>,
  b: number,
  chunkData: ArrayLike<number>,
  c: number,
  out: Float32Array | number[],
  at = 0,
): void {
  const ax = bodyData[b + 4];
  const ay = bodyData[b + 5];
  const az = bodyData[b + 6];
  const aw = bodyData[b + 7];
  const bx = chunkData[c + 4];
  const by = chunkData[c + 5];
  const bz = chunkData[c + 6];
  const bw = chunkData[c + 7];
  // vec4( a.w * b.xyz + b.w * a.xyz + cross( a.xyz, b.xyz ), a.w * b.w - dot( a.xyz, b.xyz ) )
  let x = aw * bx + bw * ax + (ay * bz - az * by);
  let y = aw * by + bw * ay + (az * bx - ax * bz);
  let z = aw * bz + bw * az + (ax * by - ay * bx);
  let w = aw * bw - (ax * bx + ay * by + az * bz);
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  if (n > 0) {
    x /= n; y /= n; z /= n; w /= n;
  }
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = w;
}

const TMP_LOCAL = new Float32Array(3);
const TMP_LOCAL_ROT = new Float32Array(4);

/**
 * Write one chunk's record: which body it rides and where it sits on it.
 * Returns false when the ledger cannot say which body the chunk is on right
 * now; the caller retries next frame and the chunk keeps drawing where it
 * was, which is the only correct thing to show.
 *
 * A chunk whose island the server retired is the exception: it is not on any
 * body and never will be again (unless a later promotion adopts it, which
 * rewrites this record). It is hidden, not left at its last pose -- a body
 * retired at the escape floor was last presented 3.5-3.75 m under the ground,
 * above the -4 m hide depth, and stayed drawn there for the rest of the match.
 */
export function writeChunkRecordInto(
  store: CityPoseStore,
  client: CityClient,
  radii: ArrayLike<number>,
  slot: number,
): boolean {
  const key = client.topology.chunkBody[slot];
  const body = client.topology.body(key);
  if (!body) {
    // Hidden once the presentation reaches the retire; until then the chunk
    // keeps drawing where it was, like any chunk whose body is not known.
    if (!client.topology.isChunkRetired(slot)) return false;
    if (client.presentedTick() < client.topology.chunkRetiredAtTick(slot)) return false;
    store.hideChunk(slot);
    return true;
  }
  const index = store.bodyIndexFor(key);
  client.topology.localOffsetInto(slot, TMP_LOCAL);
  client.topology.localRotationInto(slot, TMP_LOCAL_ROT);
  store.writeChunk(slot, index, TMP_LOCAL, TMP_LOCAL_ROT, radii[slot] ?? 0);
  return true;
}

/**
 * Write one body's pose as the ledger holds it. `tint` dims settled rubble;
 * the debug palette, when on, colours by body.
 */
export function writeBodyPoseInto(
  store: CityPoseStore,
  body: LedgerBody,
  tint: number,
  colour: BodyColour | null,
): void {
  const index = store.bodyIndexFor(body.key);
  store.writeBody(
    index,
    body.position,
    body.rotation,
    tint,
    colour ? colour.r : 1,
    colour ? colour.g : 1,
    colour ? colour.b : 1,
  );
}

/**
 * Every record and every body the ledger has, so the first frame draws the
 * city exactly as the ledger holds it -- intact, or mid-collapse for a late
 * join or a mid-game rebuild.
 */
export function initCityPoses(store: CityPoseStore, client: CityClient, radii: ArrayLike<number>): void {
  for (const body of client.topology.allBodies()) {
    writeBodyPoseInto(store, body, body.settled ? 0.75 : 1, null);
  }
  const count = client.topology.chunkCount;
  for (let slot = 0; slot < count; slot += 1) writeChunkRecordInto(store, client, radii, slot);
  store.upload();
}

/** What the per-frame step carries from one frame to the next (the layer's refs). */
export interface CityPoseFrameState {
  /** Bodies still to be written: live ones, and one-shot repaints. */
  dirty: Set<number>;
  /** Slots whose record could not be written yet (their body is not in the ledger). */
  pendingRecords: Set<number>;
  /** Bootstraps + repairs seen, to spot a ledger replaced wholesale. */
  lastLedgerEpoch: number;
}

export function newCityPoseFrameState(client: CityClient): CityPoseFrameState {
  return { dirty: new Set(), pendingRecords: new Set(), lastLedgerEpoch: client.ledgerEpoch() };
}

/** The render layer's hooks into the step; all optional. */
export interface CityPoseFrameHooks {
  /**
   * Whether a body is written this frame: the layer's distance stride
   * (renderScheduling.ts). Omitted = every body every frame (Netlab: the
   * stride is a render-rate choice and lands on the same pose).
   */
  due?: (key: number, at: ArrayLike<number> | null) => boolean;
  /** Rewrite every body this frame whatever the stride says (debug palette change). */
  repaintBodies?: boolean;
  /** Tint and colour of a body write; default: settled 0.75, else 1, no colour. */
  appearance?: (key: number, body: LedgerBody, isSupport: boolean) => { tint: number; colour: BodyColour | null };
  /** After the presentation sample (the layer times it). */
  sampled?: (live: Set<number>) => void;
  /** The ledger was replaced wholesale: every record is rewritten this frame. */
  recordsRebuilt?: () => void;
  recordWritten?: (slot: number) => void;
  /** A body the ledger no longer has, before its index is released. */
  bodyGone?: (key: number) => void;
  /** Just before a due body is written. */
  beforeBodyWrite?: (key: number, settling: boolean) => void;
  bodyWritten?: (key: number, body: LedgerBody, settling: boolean, isSupport: boolean) => void;
}

export interface CityPoseFrameResult {
  live: Set<number>;
  rebuildRecords: boolean;
  recordsWritten: number;
  /** Nothing to write this frame: the tables were left untouched (no upload). */
  idle: boolean;
}

/**
 * One frame of the city's pose tables: sample the presentation (the netcode's
 * interpolated body poses), then rewrite the records the ledger reassigned
 * and the bodies that moved. This is the step CityChunksLayer runs every
 * frame once its meshes exist; after it, `store` holds exactly what the GPU
 * composes.
 *
 * The distance stride (`hooks.due`) is a render-rate decision only: a
 * deferred body is written later at the ledger pose of that later frame.
 */
export function advanceCityPoses(
  store: CityPoseStore,
  client: CityClient,
  radii: ArrayLike<number>,
  state: CityPoseFrameState,
  nowMs: number,
  hooks: CityPoseFrameHooks = {},
): CityPoseFrameResult {
  const due = hooks.due;
  const live = client.samplePresentation(nowMs, due);
  hooks.sampled?.(live);
  const dirty = state.dirty;
  for (const key of live) {
    dirty.add(key);
  }

  // Ledger mutations that never stream (settles, promotions, migrations --
  // and everything, after a bootstrap) still have to reach the screen. The
  // dirty set only carries streaming bodies, so these ride a separate
  // one-shot queue. Adding to `dirty` (not writing directly) reuses the
  // normal write path; a repainted body that is not live gets the settling
  // final-write and then costs nothing again.
  const repaint = client.drainRepaint();
  // A ledger replaced wholesale (a bootstrap) or a structure rewritten (a
  // repair) means every chunk record and every body pose is suspect: rewrite
  // them all. Otherwise the ledger names exactly the slots it reassigned
  // since last frame.
  const ledgerEpoch = client.ledgerEpoch();
  const rebuildRecords = repaint.all || ledgerEpoch !== state.lastLedgerEpoch;
  if (rebuildRecords) {
    state.lastLedgerEpoch = ledgerEpoch;
  }
  const repaintBodies = hooks.repaintBodies === true;
  if (repaint.all || rebuildRecords || repaintBodies) {
    for (const body of client.topology.allBodies()) {
      dirty.add(body.key);
    }
  } else {
    for (const key of repaint.bodies) {
      if (client.topology.body(key)) dirty.add(key);
    }
  }

  // Chunk records: which body each chunk rides and where it sits on it.
  let recordsWritten = 0;
  let recordsTouched = false;
  if (rebuildRecords) {
    const count = client.topology.chunkCount;
    client.topology.drainSlotChanges();
    state.pendingRecords.clear();
    for (let slot = 0; slot < count; slot += 1) {
      if (!writeChunkRecordInto(store, client, radii, slot)) state.pendingRecords.add(slot);
      recordsWritten += 1;
    }
    hooks.recordsRebuilt?.();
    recordsTouched = count > 0;
  } else {
    const pending = state.pendingRecords;
    for (const slot of client.topology.drainSlotChanges()) pending.add(slot);
    for (const slot of pending) {
      // A chunk whose body the ledger cannot name yet keeps drawing where
      // it was; try again next frame.
      if (!writeChunkRecordInto(store, client, radii, slot)) continue;
      pending.delete(slot);
      recordsWritten += 1;
      recordsTouched = true;
      hooks.recordWritten?.(slot);
    }
  }

  if (dirty.size === 0 && !recordsTouched) {
    return { live, rebuildRecords, recordsWritten, idle: true };
  }

  // Body poses. Distant bodies are written on a stride (`due`); a body that
  // stopped moving gets its final write unconditionally -- deferring that
  // one would strand it at its second-to-last pose for good, since no
  // further frame will list it as live.
  for (const key of dirty) {
    const body = client.topology.body(key);
    if (!body) {
      dirty.delete(key);
      hooks.bodyGone?.(key);
      store.releaseBody(key);
      continue;
    }
    const settling = !live.has(key);
    if (!settling && !repaintBodies && due && !due(key, body.position)) {
      continue;
    }
    hooks.beforeBodyWrite?.(key, settling);
    const isSupport = (key & 0x0f_ffff) === 0;
    const look = hooks.appearance?.(key, body, isSupport) ?? { tint: body.settled ? 0.75 : 1, colour: null };
    writeBodyPoseInto(store, body, look.tint, look.colour);
    hooks.bodyWritten?.(key, body, settling, isSupport);
    if (!live.has(key)) {
      dirty.delete(key);
    }
  }
  store.upload();
  return { live, rebuildRecords, recordsWritten, idle: false };
}

/** A body's pose as a Vec3 (tests and tools). */
export function bodyPositionOf(store: CityPoseStore, index: number): Vec3 {
  const at = index * FLOATS_PER_BODY;
  return [store.bodyData[at], store.bodyData[at + 1], store.bodyData[at + 2]];
}
