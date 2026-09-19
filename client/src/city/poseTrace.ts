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
  ticks: Int32Array;
  times: Float64Array;
  capacity: number;
  frames: number;
  /** Frames dropped because the ring filled. Reported, never silent. */
  overflow: number;
}

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
export function poseTraceRecord(
  tick: number,
  timeMs: number,
  read: (slot: number, out: Float32Array) => boolean,
): void {
  if (!state) return;
  if (state.frames >= state.capacity) {
    state.overflow += 1;
    return;
  }
  const frame = state.frames;
  const base = frame * state.slots.length * 3;
  const scratch = new Float32Array(3);
  for (let index = 0; index < state.slots.length; index += 1) {
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
        return { slots: [], frames: 0, overflow: 0, ticks: [], times: [], positions: [] };
      }
      const used = current.frames * current.slots.length * 3;
      return {
        slots: Array.from(current.slots),
        frames: current.frames,
        overflow: current.overflow,
        ticks: Array.from(current.ticks.subarray(0, current.frames)),
        times: Array.from(current.times.subarray(0, current.frames)),
        positions: Array.from(current.positions.subarray(0, used)),
      };
    },
    armed() {
      return state !== null;
    },
  };
  (window as unknown as { __VIBE_POSE_TRACE__: PoseTraceBridge }).__VIBE_POSE_TRACE__ = bridge;
}
