// The driven car's input pipeline, simulated end to end on a millisecond clock:
// the client's frames and fixed-rate input bundler (the real FixedInputBundler),
// what it sends, an uplink with delay, jitter (which reorders) and loss, the
// server's queue (enqueue and one input per tick), and the acks back down.
//
// The driver's prediction assumes the server applies its inputs in order, one
// per tick, each exactly once. Every tick the server instead repeats an input
// (its queue ran dry) or never applies one (dropped: lost, rejected as old, or
// collapsed out of a backlog) is a misprediction: the next snapshot corrects
// the car by about a tick of its motion. Live, a weaving drive measured
// 585-1,493 starved ticks and 300-1,243 collapsed inputs a minute
// (docs/vehicle-city-measurement.md). This finds which pipeline avoids them.
//
// The server policies mirror server/src/main.rs: `enqueue_inputs` and
// `take_input_for_tick_with_vehicle_catchup` (VEHICLE_INPUT_CATCHUP_THRESHOLD 4,
// MAX_PENDING_INPUTS 120).
import { FixedInputBundler } from '../../src/runtime/fixedInputBundler';
import type { SemanticInputState } from '../../src/input/types';
import { inputClockRate } from '../../src/runtime/inputPacing';
import { INPUT_BUNDLE_MAX_FRAMES } from '../../src/net/protocol';

const TICK_MS = 1000 / 60;
const newer = (a: number, b: number) => a !== b && ((a - b) & 0xffff) < 0x8000;

/** Seeded uniform [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FrameModel {
  /** The next frame's duration, ms. */
  next(random: () => number): number;
}
/** A steady display: frames of `ms` with uniform +-`jitterMs`, and a `hitchMs` frame with probability `hitchP`. */
export const frames = (ms: number, jitterMs = 0, hitchP = 0, hitchMs = 0): FrameModel => ({
  next: (r) => (r() < hitchP ? hitchMs : ms + (r() * 2 - 1) * jitterMs),
});

export interface LinkModel {
  delayMs: number;
  /** Uniform +-jitter per packet: later packets can overtake earlier ones. */
  jitterMs: number;
  loss: number;
}

export interface ClientPolicy {
  /** Inputs per packet while driving: the newest unacked this many (the shipping 3), or all unacked. */
  resend: number | 'all';
  /** Most unacked inputs one packet carries with `resend: 'all'`. */
  cap?: number;
  /** Speed the input clock to keep the server's queue near this many inputs (server-reported depth); off when absent. */
  dilateToDepth?: number;
  /** Seconds the dilation closes a depth error over. */
  dilateCloseSec?: number;
}

export interface ServerPolicy {
  /** 'received': accept only seqs newer than the newest received (shipping); 'applied': any seq newer than the last applied, in order. */
  accept: 'received' | 'applied';
  /** Collapse a backlog of this many or more to its newest (shipping 4); never when absent. */
  collapseAt?: number;
  /** Wait for the next seq when a later one is queued (until it is this many ticks late), rather than skipping over the gap. */
  waitForGapTicks?: number;
  /** Report a target depth from measured arrival jitter: the spread of input
   * lateness (arrival tick minus seq) from its least to this quantile, over
   * the last `jitterWindow` inputs, rounded up. The client dilates to it. */
  targetQuantile?: number;
  jitterWindow?: number;
}

export interface PipelineResult {
  ticks: number;
  /** Ticks the server repeated its last input (queue empty, or waiting for a gap). */
  starved: number;
  /** Inputs the client made that the server never applied. */
  dropped: number;
  /** Starved and dropped, a minute: corrections the driver will see. */
  mispredictionsPerMin: number;
  /** Ticks from an input's production to its application, p50 and p95. */
  delayTicks: { p50: number; p95: number };
  /** The server's queue depth after each tick, mean. */
  meanDepth: number;
}

const idle: SemanticInputState = {} as SemanticInputState;

/** One simulated drive of `seconds`. */
export function simulatePipeline(opts: {
  seconds: number;
  seed: number;
  frames: FrameModel;
  uplink: LinkModel;
  downlink: LinkModel;
  client: ClientPolicy;
  server: ServerPolicy;
}): PipelineResult {
  const r = rng(opts.seed);
  const bundler = new FixedInputBundler(1 / 60, 4);
  type Cmd = { seq: number; madeMs: number };
  const made = new Map<number, number>(); // seq -> production time
  const pending: Cmd[] = []; // unacked, in order
  // Events: packets up (inputs) and down (ack seq, server queue depth).
  const up: { at: number; cmds: Cmd[] }[] = [];
  const down: { at: number; ack: number | null; depth: number; target: number | null }[] = [];
  const lateness: number[] = [];
  let unwrapped = 0;
  let lastSeqSeen: number | null = null;
  let reportedTarget: number | null = null;
  let knownTarget: number | null = null;
  // Server state.
  const queue: Cmd[] = [];
  let lastReceived: number | null = null;
  let lastApplied: number | null = null;
  let gapWait = 0;
  let starved = 0;
  const applied = new Set<number>();
  const delays: number[] = [];
  let depthSum = 0;
  // Client clock.
  let clientMs = r() * TICK_MS;
  let knownDepth: number | null = null;
  let dilation = 1;
  let tick = 0;
  const endMs = opts.seconds * 1000;
  const serverPhase = r() * TICK_MS;

  const sendPacket = (now: number, cmds: Cmd[]) => {
    if (r() < opts.uplink.loss) return;
    up.push({ at: now + opts.uplink.delayMs + (r() * 2 - 1) * opts.uplink.jitterMs, cmds: cmds.map((c) => ({ ...c })) });
  };
  const enqueue = (cmds: Cmd[], arrivalMs: number) => {
    for (const cmd of cmds) {
      if (opts.server.targetQuantile !== undefined && (lastSeqSeen === null || newer(cmd.seq, lastSeqSeen))) {
        unwrapped += lastSeqSeen === null ? cmd.seq : (cmd.seq - lastSeqSeen) & 0xffff;
        lastSeqSeen = cmd.seq;
        lateness.push(arrivalMs / TICK_MS - unwrapped);
        if (lateness.length > (opts.server.jitterWindow ?? 120)) lateness.shift();
        const sorted = [...lateness].sort((a, b) => a - b);
        const at = sorted[Math.min(sorted.length - 1, Math.floor(opts.server.targetQuantile * sorted.length))];
        reportedTarget = Math.ceil(at - sorted[0]);
      }
      if (opts.server.accept === 'received') {
        if (lastReceived !== null && !newer(cmd.seq, lastReceived)) continue;
        lastReceived = cmd.seq;
        queue.push(cmd);
      } else {
        if (lastApplied !== null && !newer(cmd.seq, lastApplied)) continue;
        if (queue.some((q) => q.seq === cmd.seq)) continue;
        const at = queue.findIndex((q) => newer(q.seq, cmd.seq));
        if (at < 0) queue.push(cmd); else queue.splice(at, 0, cmd);
      }
      while (queue.length > 120) queue.shift();
    }
  };
  const apply = (cmd: Cmd) => {
    lastApplied = cmd.seq;
    applied.add(cmd.seq);
    delays.push((tick * TICK_MS + serverPhase - cmd.madeMs) / TICK_MS);
  };
  const serverTick = () => {
    const now = tick * TICK_MS + serverPhase;
    // Arrivals up to now, in arrival order.
    up.sort((a, b) => a.at - b.at);
    while (up.length && up[0].at <= now) { const p = up.shift()!; enqueue(p.cmds, p.at); }
    const collapse = opts.server.collapseAt;
    if (collapse !== undefined && queue.length >= collapse) {
      const newest = queue[queue.length - 1];
      queue.length = 0;
      apply(newest);
    } else if (queue.length) {
      const next = lastApplied === null ? queue[0].seq : (lastApplied + 1) & 0xffff;
      const wait = opts.server.waitForGapTicks;
      if (wait !== undefined && queue[0].seq !== next && gapWait < wait) {
        gapWait += 1;
        starved += 1;
      } else {
        gapWait = 0;
        apply(queue.shift()!);
      }
    } else {
      starved += 1;
    }
    depthSum += queue.length;
    if (r() >= opts.downlink.loss) {
      down.push({ at: now + opts.downlink.delayMs + (r() * 2 - 1) * opts.downlink.jitterMs, ack: lastApplied, depth: queue.length, target: reportedTarget });
    }
    tick += 1;
  };

  while (clientMs < endMs) {
    // Server ticks up to the client's now.
    while (tick * TICK_MS + serverPhase <= clientMs) serverTick();
    // Snapshots that reached the client.
    down.sort((a, b) => a.at - b.at);
    while (down.length && down[0].at <= clientMs) {
      const s = down.shift()!;
      if (s.ack !== null) while (pending.length && !newer(pending[0].seq, s.ack)) pending.shift();
      knownDepth = s.depth;
      knownTarget = s.target;
    }
    // A frame: the bundler makes this frame's inputs on the (dilated) input clock.
    const frameMs = Math.max(0.5, opts.frames.next(r));
    const target = knownTarget ?? opts.client.dilateToDepth;
    if (target !== undefined && knownDepth !== null) {
      const close = opts.client.dilateCloseSec;
      // The runtime's own rule, unless a sweep sets its time constant.
      dilation = close === undefined
        ? inputClockRate({ depth: knownDepth, target })
        : Math.max(0, 1 + (target - knownDepth) / (60 * close));
    }
    const cmds = bundler.produce((frameMs / 1000) * dilation, idle);
    for (const c of cmds) {
      const cmd = { seq: c.seq, madeMs: clientMs };
      made.set(c.seq, clientMs);
      pending.push(cmd);
    }
    if (cmds.length) {
      const policy = opts.client.resend;
      const out = policy === 'all' ? pending.slice(-(opts.client.cap ?? 64)) : pending.slice(-policy);
      sendPacket(clientMs, out.length ? out : cmds.map((c) => ({ seq: c.seq, madeMs: clientMs })));
    }
    clientMs += frameMs;
  }
  // Inputs made at least a second before the end that never applied.
  let dropped = 0;
  for (const [seq, at] of made) if (at < endMs - 1000 && !applied.has(seq)) dropped += 1;
  delays.sort((a, b) => a - b);
  const q = (p: number) => delays[Math.min(delays.length - 1, Math.floor(p * delays.length))] ?? NaN;
  const minutes = opts.seconds / 60;
  return {
    ticks: tick,
    starved,
    dropped,
    mispredictionsPerMin: (starved + dropped) / minutes,
    delayTicks: { p50: q(0.5), p95: q(0.95) },
    meanDepth: depthSum / Math.max(1, tick),
  };
}

/** The shipping pipeline (2026-10-11). */
export const SHIPPING = { client: { resend: 3 } as ClientPolicy, server: { accept: 'received', collapseAt: 4 } as ServerPolicy };
/** VIBE_VEHICLE_INPUT_PACING: resend all unacked, ordered queue, no collapse, p95 jitter target. */
export const PACED = {
  client: { resend: 'all', cap: INPUT_BUNDLE_MAX_FRAMES } as ClientPolicy,
  server: { accept: 'applied', targetQuantile: 0.95, jitterWindow: 120 } as ServerPolicy,
};
