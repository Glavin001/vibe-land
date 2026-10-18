// City body poses read from memory: the native app's single-player session,
// where the server's match loop runs in this process (server/src/pose_feed.rs).
//
// Over a network the pose stream is budgeted: each moving body arrives every
// few ticks, quantised, and the client presents a playout delay behind the
// newest tick to interpolate between them. In-process none of that is
// needed. The server publishes every awake body's exact float pose every
// tick, and the client draws the newest tick as it is: no delay, no
// interpolation, no quantisation.
//
// One thing still orders them: topology (fractures, settles, wakes) arrives
// on the reliable packets, and body poses are in a centre-of-mass frame that
// a fracture moves. Each frame carries the topology sequence the server had
// reached at its tick, and the client draws the newest frame at the sequence
// it has applied -- the newest tick, unless that tick's topology is still in
// the packet pump, when it is the tick before. A body the frame does not hold
// (it is asleep on the server) is left to the stream.

import type { Quat, Vec3 } from './vec';

/** Words per body: entity, position xyz, rotation xyzw, linear velocity xyz. */
const WORDS_PER_BODY = 11;
/** Words before a frame's bodies: tick, topology sequence, body count. */
const FRAME_HEADER_WORDS = 3;
/** Frames kept: a reader one or two ticks behind on topology still finds its own. */
const FRAMES_KEPT = 8;

/** What the native session exposes (InProcessLink.poses). */
export interface PoseFeedSource {
  poses(sinceTick: number): ArrayBuffer;
}

export interface PoseFrame {
  tick: number;
  topoSeq: number;
  /** body entity -> index of its first word in `floats` */
  index: Map<number, number>;
  floats: Float32Array;
}

export interface FeedPose {
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
}

export class CityPoseFeed {
  private readonly frames: PoseFrame[] = [];
  private newest = -1;
  /** Frames received, and bodies in them, for the perf report. */
  framesReceived = 0;
  bodiesReceived = 0;

  constructor(private readonly source: PoseFeedSource) {}

  /** The newest tick received, or -1. */
  latestTick(): number {
    return this.newest;
  }

  /** Read the frames published since the last poll. */
  poll(): void {
    const buffer = this.source.poses(Math.max(0, this.newest));
    if (buffer.byteLength === 0) return;
    const words = new Uint32Array(buffer);
    const floats = new Float32Array(buffer);
    let at = 0;
    while (at + FRAME_HEADER_WORDS <= words.length) {
      const tick = words[at];
      const topoSeq = words[at + 1];
      const count = words[at + 2];
      const first = at + FRAME_HEADER_WORDS;
      const index = new Map<number, number>();
      for (let i = 0; i < count; i += 1) index.set(words[first + i * WORDS_PER_BODY], first + i * WORDS_PER_BODY);
      at = first + count * WORDS_PER_BODY;
      if (tick <= this.newest && this.newest >= 0) continue;
      this.frames.push({ tick, topoSeq, index, floats });
      this.newest = tick;
      this.framesReceived += 1;
      this.bodiesReceived += count;
    }
    if (this.frames.length > FRAMES_KEPT) this.frames.splice(0, this.frames.length - FRAMES_KEPT);
  }

  /** Forget everything (a reset or resync restarts the ticks). */
  clear(): void {
    this.frames.length = 0;
    this.newest = -1;
  }

  /** The newest frame published at topology sequence `topoSeq`. */
  newestAt(topoSeq: number): PoseFrame | undefined {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (frame.topoSeq === topoSeq) return frame;
      if (frame.topoSeq < topoSeq) return undefined;
    }
    return undefined;
  }

  /** The entities `frame` holds a pose for. */
  entities(frame: PoseFrame): IterableIterator<number> {
    return frame.index.keys();
  }

  /** Body `key`'s pose in `frame`, exactly as simulated; false if the frame does not hold it. */
  sample(frame: PoseFrame, key: number, out: FeedPose): boolean {
    const at = frame.index.get(key);
    if (at === undefined) return false;
    const f = frame.floats;
    out.position[0] = f[at + 1];
    out.position[1] = f[at + 2];
    out.position[2] = f[at + 3];
    out.rotation[0] = f[at + 4];
    out.rotation[1] = f[at + 5];
    out.rotation[2] = f[at + 6];
    out.rotation[3] = f[at + 7];
    out.linearVelocity[0] = f[at + 8];
    out.linearVelocity[1] = f[at + 9];
    out.linearVelocity[2] = f[at + 10];
    return true;
  }
}
