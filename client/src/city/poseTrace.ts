/**
 * Per-frame pose trace for a chosen set of chunks — window.__VIBE_POSE_TRACE__
 *
 * A video shows that a collapse looks wrong; it cannot show which chunk went
 * where, or when. This records the pose a chosen set of chunks was DRAWN at,
 * every frame, so a recording can be read back frame by frame beside the
 * pixels and the two lined up against the server's own 60 Hz state.
 *
 * Off by default and free when off: `wanted()` is a null check, and call sites
 * are expected to guard on it so they do not even compose a sample.
 *
 * Deliberately small: a fixed set of slots chosen once, a preallocated ring,
 * and no allocation per frame. Tracing all 24,105 chunks of a downtown at
 * 60 Hz would be 17 MB a second and would itself change what it measures.
 */

export interface PoseTraceSample {
  /** Frame index since arming. */
  frame: number;
  /** Client render clock tick the frame was composed at, -1 if unknown. */
  tick: number;
  /** performance.now() at the frame. */
  timeMs: number;
  /** Drawn world positions, three floats per tracked slot, in slot order. */
  positions: Float32Array;
}

interface TraceState {
  slots: Int32Array;
  positions: Float32Array;
  /**
   * The composition's INPUTS: body position (3) and body rotation (4) per
   * tracked slot per frame.
   *
   * A composed world pose that jumps says only that something upstream moved.
   * `chunk_world = body_pose ∘ (rest_local − island_com)` has two terms and a
   * body identity, and which of the three changed is the entire question. A
   * capture that records only the result can show a whole building stepping
   * two metres sideways and cannot say whether the body moved, its frame was
   * rebased, or the chunk changed hands.
   */
  bodyPoses: Float32Array;
  /** Local offset (3) per tracked slot per frame: the other term. */
  localOffsets: Float32Array;
  /** Which body each tracked chunk belonged to, per frame. */
  bodyKeys: Int32Array;
  /** Per tracked slot per frame: index into POSE_SOURCES, or -1. */
  sources: Int8Array;
  ticks: Int32Array;
  times: Float64Array;
  capacity: number;
  frames: number;
  /** Frames dropped because the ring filled. Reported, never silent. */
  overflow: number;
}

/** Filled by the caller for one slot: body pos/rot, local offset, body key. */
export interface PoseTerms {
  bodyPosition: Float32Array;
  bodyRotation: Float32Array;
  localOffset: Float32Array;
  bodyKey: number;
  /**
   * Which writer last set this body's pose, as an index into
   * `POSE_SOURCES`.
   *
   * Knowing that a body's pose moved is not the same as knowing what moved
   * it. Six different paths write a body pose -- a streamed record, a settle,
   * a promotion, a frame rebase, a bootstrap, the presentation layer -- and
   * naming the one responsible turns "a slab jumped" into a single code path
   * to read.
   */
  sourceIndex: number;
}

/** Index order for `PoseTerms.sourceIndex`; -1 means nothing has written yet. */
export const POSE_SOURCES = [
  'raw',
  'presented',
  'settle',
  'promote',
  'reoffset',
  'bootstrap',
] as const;

let state: TraceState | null = null;

/** Whether a trace is armed. One null check. */
export function poseTraceWanted(): boolean {
  return state !== null;
}

/** Slots being traced, or an empty array. */
export function poseTraceSlots(): Int32Array {
  return state ? state.slots : new Int32Array(0);
}

/**
 * Record one frame. `read(slot, out)` must fill `out` with the drawn world
 * position of that slot; it is called once per tracked slot per frame.
 */
const TERMS: PoseTerms = {
  bodyPosition: new Float32Array(3),
  bodyRotation: new Float32Array(4),
  localOffset: new Float32Array(3),
  bodyKey: -1,
  sourceIndex: -1,
};

export function poseTraceRecord(
  tick: number,
  timeMs: number,
  read: (slot: number, out: Float32Array) => boolean,
  readTerms?: (slot: number, out: PoseTerms) => void,
): void {
  if (!state) return;
  if (state.frames >= state.capacity) {
    state.overflow += 1;
    return;
  }
  const frame = state.frames;
  const count = state.slots.length;
  const base = frame * count * 3;
  const scratch = new Float32Array(3);
  for (let index = 0; index < count; index += 1) {
    if (readTerms) {
      TERMS.bodyKey = -1;
      TERMS.sourceIndex = -1;
      TERMS.bodyPosition.fill(Number.NaN);
      TERMS.bodyRotation.fill(Number.NaN);
      TERMS.localOffset.fill(Number.NaN);
      readTerms(state.slots[index], TERMS);
      const poseAt = (frame * count + index) * 7;
      state.bodyPoses[poseAt] = TERMS.bodyPosition[0];
      state.bodyPoses[poseAt + 1] = TERMS.bodyPosition[1];
      state.bodyPoses[poseAt + 2] = TERMS.bodyPosition[2];
      state.bodyPoses[poseAt + 3] = TERMS.bodyRotation[0];
      state.bodyPoses[poseAt + 4] = TERMS.bodyRotation[1];
      state.bodyPoses[poseAt + 5] = TERMS.bodyRotation[2];
      state.bodyPoses[poseAt + 6] = TERMS.bodyRotation[3];
      const localAt = (frame * count + index) * 3;
      state.localOffsets[localAt] = TERMS.localOffset[0];
      state.localOffsets[localAt + 1] = TERMS.localOffset[1];
      state.localOffsets[localAt + 2] = TERMS.localOffset[2];
      state.bodyKeys[frame * count + index] = TERMS.bodyKey;
      state.sources[frame * count + index] = TERMS.sourceIndex;
    }
    const at = base + index * 3;
    if (read(state.slots[index], scratch)) {
      state.positions[at] = scratch[0];
      state.positions[at + 1] = scratch[1];
      state.positions[at + 2] = scratch[2];
    } else {
      // Unresolved is not the same as the origin, and a trace that cannot
      // tell them apart would put a chunk at (0,0,0) on every frame its body
      // was missing -- which reads on a plot as a teleport to the map centre.
      state.positions[at] = Number.NaN;
      state.positions[at + 1] = Number.NaN;
      state.positions[at + 2] = Number.NaN;
    }
  }
  state.ticks[frame] = tick;
  state.times[frame] = timeMs;
  state.frames = frame + 1;
}

export interface PoseTraceBridge {
  /** Begin tracing these chunk slots for at most `frames` frames. */
  arm(slots: number[], frames: number): { slots: number; frames: number };
  /** Stop, and return everything recorded. */
  drain(): {
    slots: number[];
    frames: number;
    overflow: number;
    ticks: number[];
    times: number[];
    /** Flat, frames x slots x 3. */
    positions: number[];
    /** Flat, frames x slots x 7: body position then body rotation. */
    bodyPoses: number[];
    /** Flat, frames x slots x 3. */
    localOffsets: number[];
    /** Flat, frames x slots. */
    bodyKeys: number[];
    /** Flat, frames x slots: index into POSE_SOURCES, -1 if never written. */
    sources: number[];
  };
  armed(): boolean;
}

export function installPoseTrace(): void {
  const bridge: PoseTraceBridge = {
    arm(slots, frames) {
      const capacity = Math.max(1, Math.min(frames, 20_000));
      const chosen = Int32Array.from(slots);
      state = {
        slots: chosen,
        positions: new Float32Array(capacity * chosen.length * 3),
        bodyPoses: new Float32Array(capacity * chosen.length * 7),
        localOffsets: new Float32Array(capacity * chosen.length * 3),
        bodyKeys: new Int32Array(capacity * chosen.length),
        sources: new Int8Array(capacity * chosen.length),
        ticks: new Int32Array(capacity),
        times: new Float64Array(capacity),
        capacity,
        frames: 0,
        overflow: 0,
      };
      return { slots: chosen.length, frames: capacity };
    },
    drain() {
      const current = state;
      state = null;
      if (!current) {
        return {
          slots: [], frames: 0, overflow: 0, ticks: [], times: [],
          positions: [], bodyPoses: [], localOffsets: [], bodyKeys: [], sources: [],
        };
      }
      const cells = current.frames * current.slots.length;
      return {
        slots: Array.from(current.slots),
        frames: current.frames,
        overflow: current.overflow,
        ticks: Array.from(current.ticks.subarray(0, current.frames)),
        times: Array.from(current.times.subarray(0, current.frames)),
        positions: Array.from(current.positions.subarray(0, cells * 3)),
        bodyPoses: Array.from(current.bodyPoses.subarray(0, cells * 7)),
        localOffsets: Array.from(current.localOffsets.subarray(0, cells * 3)),
        bodyKeys: Array.from(current.bodyKeys.subarray(0, cells)),
        sources: Array.from(current.sources.subarray(0, cells)),
      };
    },
    armed() {
      return state !== null;
    },
  };
  (window as unknown as { __VIBE_POSE_TRACE__: PoseTraceBridge }).__VIBE_POSE_TRACE__ = bridge;
}
