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
  /** The next frame's duration, ms, for a frame starting at `nowMs`. */
  next(random: () => number, nowMs: number): number;
}
/** A steady display: frames of `ms` with uniform +-`jitterMs`, and a `hitchMs` frame with probability `hitchP`. */
export const frames = (ms: number, jitterMs = 0, hitchP = 0, hitchMs = 0): FrameModel => ({
  next: (r) => (r() < hitchP ? hitchMs : ms + (r() * 2 - 1) * jitterMs),
});

/** A frame model whose display stops for `stallMs` at `atMs` (a background
 * tab, an alt-tab, a GC pause, a shader compile): one frame that long. */
export const stalled = (base: FrameModel, atMs: number, stallMs: number): FrameModel => {
  let done = false;
  return {
    next: (r, nowMs) => {
      if (!done && nowMs >= atMs) { done = true; return stallMs; }
      return base.next(r, nowMs);
    },
  };
};

/** The link over an interval of the drive: replaces delay, jitter or loss. */
export interface LinkEvent {
  fromMs: number;
  toMs: number;
  delayMs?: number;
  jitterMs?: number;
  /** 1 is an outage. */
  loss?: number;
}

export interface LinkModel {
  delayMs: number;
  /** Uniform +-jitter per packet: later packets can overtake earlier ones. */
  jitterMs: number;
  loss: number;
  /** Gilbert-Elliott burst loss (netem `gemodel`, percent per packet): p is
   * good to bad, r bad to good; every packet in the bad state is lost. */
  burst?: { p: number; r: number };
  /** Probability a packet is delivered twice (independent delays). */
  duplicate?: number;
  events?: LinkEvent[];
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
  /** Bound on the input clock's correction (0.05: within 5% of the target rate). */
  maxRateDeviation?: number;
  /** Run the input clock at the server's measured simulation rate (from its
   * snapshots' ticks against its wall clock), corrected within the bound. */
  followServerRate?: boolean;
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
  /** Take lateness after removing the client clock's rate (the least-squares
   * slope of arrival on sequence, over a full window), as the server does
   * (server/src/vehicle_input_pacing.rs); false is the first, drifting version. */
  removeSkew?: boolean;
  /** One lateness sample a packet, its newest input (the server's rule);
   * otherwise every input's first arrival (the first version). */
  samplePerPacket?: boolean;
  /** How the clock rate is fitted with removeSkew: a lower bound (Moon et
   * al., the server's) or least squares (commit b0b3e846). */
  skewFit?: 'lp' | 'lsq';
  /** Clip each packet's lateness samples at what the queue could ever hold
   * (the target before the packet + dropBeyondTarget + 1): later inputs are
   * dropped as stale, late loss rather than jitter. */
  clipLateLoss?: boolean;
  /** At most (1 - targetQuantile) x jitterWindow samples a packet (the most
   * late of its new inputs): one event, however long, cannot move the
   * quantile by itself; recurring ones still do. */
  capSamplesPerPacket?: boolean;
  /** Drop the oldest queued inputs beyond the target plus this many: a
   * backlog the client's bounded correction cannot close in time. */
  dropBeyondTarget?: number;
}

export interface PipelineResult {
  ticks: number;
  /** Ticks the server repeated its last input (queue empty, or waiting for a gap). */
  starved: number;
  /** Inputs the client made that the server never applied. */
  dropped: number;
  /** Starved and dropped, a minute: corrections the driver will see. */
  mispredictionsPerMin: number;
  /** Of those, the ticks whose applied controls differ from what a perfect
   * pipeline applies (one per tick, in order, once): a repeat or skip of
   * unchanged controls changes nothing. Needs `controlChangeMeanMs`. */
  effectivePerMin: number;
  /** Ticks from an input's production to its application, p50 and p95. */
  delayTicks: { p50: number; p95: number };
  /** The server's queue depth after each tick, mean. */
  meanDepth: number;
  /** The queue depth after each tick, mean over each second. */
  depthBySecond: number[];
}

const idle: SemanticInputState = {} as SemanticInputState;

/** One server tick of a traced drive. */
export interface TickTrace {
  tick: number;
  atMs: number;
  /** Queue depth after the tick. */
  depth: number;
  /** The tick repeated the last input (none queued, or waiting on a gap). */
  starved: boolean;
  /** The applied input's sequence, or null (starved). */
  seq: number | null;
  /** The target depth the server reported with this tick (null: none yet). */
  target: number | null;
}

/** One client frame of a traced drive. */
export interface FrameTrace {
  atMs: number;
  /** The input clock's rate this frame (1 = real time). */
  rate: number;
  /** The server's simulation rate as the client measured it (1 without a measure). */
  simRate: number;
  inputs: number;
}

/** One simulated drive of `seconds`. */
export function simulatePipeline(opts: {
  seconds: number;
  seed: number;
  frames: FrameModel;
  uplink: LinkModel;
  downlink: LinkModel;
  client: ClientPolicy;
  server: ServerPolicy;
  /** Duration of server tick `tick`, ms (a server running behind: a collapse
   * at 30 Hz is 33.3). Real time by default. */
  serverTickMs?: (tick: number) => number;
  /** The client's clock rate against the server's (1.001: 0.1% fast). */
  clientClockRate?: number;
  /** Keep per-tick and per-frame traces. */
  trace?: boolean;
  /** The driver changes controls at random (Poisson), this often on
   * average; each input carries the controls when it was made. */
  controlChangeMeanMs?: number;
}): PipelineResult & {
  ticksTrace?: TickTrace[];
  framesTrace?: FrameTrace[];
  /** Each input: made, first reached the server, applied (null: never). */
  inputs?: { seq: number; madeMs: number; arrivedMs: number | null; appliedMs: number | null }[];
} {
  const r = rng(opts.seed);
  // The driver's controls: a value that changes at Poisson times (its own
  // random stream, so the pipeline's draws are unchanged).
  const rc = rng(opts.seed ^ 0x9e3779b9);
  let control = 0;
  let nextChangeMs = opts.controlChangeMeanMs ? -Math.log(1 - rc()) * opts.controlChangeMeanMs : Infinity;
  const controlOf = new Map<number, number>();
  const bundler = new FixedInputBundler(1 / 60, 4);
  type Cmd = { seq: number; madeMs: number };
  const made = new Map<number, number>(); // seq -> production time
  const pending: Cmd[] = []; // unacked, in order
  // Events: packets up (inputs) and down (ack seq, server queue depth).
  const up: { at: number; cmds: Cmd[] }[] = [];
  const down: { at: number; ack: number | null; depth: number; target: number | null; tick: number; wallMs: number }[] = [];
  const serverSeen: { tick: number; wallMs: number }[] = [];
  const arrivals: [number, number][] = []; // (unwrapped seq, arrival tick)
  let unwrapped = 0;
  let lastSeqSeen: number | null = null;
  let reportedTarget: number | null = null;
  let knownTarget: number | null = null;
  // Server state.
  const queue: Cmd[] = [];
  let lastReceived: number | null = null;
  let lastApplied: number | null = null;
  let gapWait = 0;
  let dropsForBacklog = 0;
  let starved = 0;
  const applied = new Set<number>();
  const delays: number[] = [];
  let depthSum = 0;
  const depthBySecond: number[] = [];
  // Client clock.
  let clientMs = r() * TICK_MS;
  let knownDepth: number | null = null;
  let dilation = 1;
  let simRate = 1;
  let tick = 0;
  const endMs = opts.seconds * 1000;
  const serverPhase = r() * TICK_MS;

  // A link's state at `now`: its events override delay, jitter and loss.
  const linkAt = (link: LinkModel, now: number) => {
    const e = link.events?.find((ev) => now >= ev.fromMs && now < ev.toMs);
    return { delayMs: e?.delayMs ?? link.delayMs, jitterMs: e?.jitterMs ?? link.jitterMs, loss: e?.loss ?? link.loss };
  };
  const burstBad = new Map<LinkModel, boolean>();
  // Delivery times of one packet sent at `now` (none: lost; two: duplicated).
  // Draws no random numbers for features a link does not have.
  const deliver = (link: LinkModel, now: number): number[] => {
    const at = linkAt(link, now);
    if (link.burst) {
      const bad = burstBad.get(link) ?? false;
      const next = bad ? r() * 100 >= link.burst.r : r() * 100 < link.burst.p;
      burstBad.set(link, next);
      if (next) return [];
    }
    if (r() < at.loss) return [];
    const one = () => now + at.delayMs + (r() * 2 - 1) * at.jitterMs;
    const times = [one()];
    if (link.duplicate && r() < link.duplicate) times.push(one());
    return times;
  };
  const sendPacket = (now: number, cmds: Cmd[]) => {
    for (const at of deliver(opts.uplink, now)) up.push({ at, cmds: cmds.map((c) => ({ ...c })) });
  };
  const enqueue = (cmds: Cmd[], arrivalMs: number) => {
    // Which of this packet's inputs are lateness samples (null: all).
    let sampledSeqs: Set<number> | null = null;
    if (opts.server.capSamplesPerPacket && opts.server.targetQuantile !== undefined) {
      // Fewer than the samples above the quantile's rank (floor(q n)): with
      // 120 and 0.95, rank 114, so 5.
      const n = opts.server.jitterWindow ?? 120;
      const k = n - Math.floor(opts.server.targetQuantile * n) - 1;
      const fresh = cmds.filter((c) => lastSeqSeen === null || newer(c.seq, lastSeqSeen)).map((c) => c.seq);
      // The most late are the oldest sequences.
      fresh.sort((a, b) => (newer(a, b) ? 1 : -1));
      sampledSeqs = new Set(fresh.slice(0, k));
      // And the newest always: the network's own delay.
      if (fresh.length) sampledSeqs.add(fresh[fresh.length - 1]);
    }
    const clipAt = opts.server.clipLateLoss && reportedTarget !== null ? reportedTarget + (opts.server.dropBeyondTarget ?? 0) + 1 : null;
    const newestInPacket = cmds.reduce((a, c) => (newer(c.seq, a) ? c.seq : a), cmds[0]?.seq ?? 0);
    for (const cmd of cmds) {
      if (!arrivedAt.has(cmd.seq)) arrivedAt.set(cmd.seq, arrivalMs);
      const sampled = (!opts.server.samplePerPacket || cmd.seq === newestInPacket) && (sampledSeqs === null || sampledSeqs.has(cmd.seq));
      // A sample: the first arrival of an input the policy samples.
      if (opts.server.targetQuantile !== undefined && sampled && (lastSeqSeen === null || newer(cmd.seq, lastSeqSeen))) {
        unwrapped += lastSeqSeen === null ? cmd.seq : (cmd.seq - lastSeqSeen) & 0xffff;
        lastSeqSeen = cmd.seq;
        const window = opts.server.jitterWindow ?? 120;
        // The server sees whole ticks: the next it simulates.
        let arrivalTick = nextTickAt(arrivalMs);
        if (clipAt !== null && arrivals.length) {
          // Lateness relative to the window's least (trend aside: skew is small).
          const least = Math.min(...arrivals.map(([x, y]) => y - x));
          arrivalTick = Math.min(arrivalTick, unwrapped + least + clipAt);
        }
        arrivals.push([unwrapped, arrivalTick]);
        if (arrivals.length > window) arrivals.shift();
        reportedTarget = jitterTarget(arrivals, opts.server.targetQuantile, opts.server.removeSkew ? window : Infinity, opts.server.skewFit ?? 'lp');
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
  const serverAt = (t: number) => (opts.serverTickMs ? serverStart[t] ?? Infinity : t * TICK_MS + serverPhase);
  // Server tick start times when scheduled (cumulative).
  const serverStart: number[] = [serverPhase];
  const appliedAt = new Map<number, number>();
  const arrivedAt = new Map<number, number>();
  const ticksTrace: TickTrace[] = [];
  const appliedSeqs: (number | null)[] = [];
  const appliedTickMs: number[] = [];
  const framesTrace: FrameTrace[] = [];
  let appliedThisTick: number | null = null;
  // The server sees arrivals in whole ticks: the next it simulates.
  const nextTickAt = (ms: number) => {
    if (!opts.serverTickMs) return Math.ceil((ms - serverPhase) / TICK_MS);
    let t = tick;
    while (serverAt(t) < ms && Number.isFinite(serverAt(t + 1))) t += 1;
    return serverAt(t) < ms ? t + 1 : t;
  };
  const apply = (cmd: Cmd) => {
    lastApplied = cmd.seq;
    applied.add(cmd.seq);
    appliedThisTick = cmd.seq;
    const now = serverAt(tick);
    appliedAt.set(cmd.seq, now);
    delays.push((now - cmd.madeMs) / TICK_MS);
  };
  const serverTick = () => {
    const now = serverAt(tick);
    appliedThisTick = null;
    const starvedBefore = starved;
    // Arrivals up to now, in arrival order.
    up.sort((a, b) => a.at - b.at);
    while (up.length && up[0].at <= now) { const p = up.shift()!; enqueue(p.cmds, p.at); }
    const beyond = opts.server.dropBeyondTarget;
    if (beyond !== undefined && reportedTarget !== null) {
      // After this tick consumes one, keep at most target + beyond.
      while (queue.length - 1 > reportedTarget + beyond) { queue.shift(); dropsForBacklog += 1; }
    }
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
    const second = Math.floor(tick / 60);
    depthBySecond[second] = (depthBySecond[second] ?? 0) + queue.length / 60;
    for (const at of deliver(opts.downlink, now)) down.push({ at, ack: lastApplied, depth: queue.length, target: reportedTarget, tick, wallMs: now });
    appliedSeqs.push(appliedThisTick);
    appliedTickMs.push(now);
    if (opts.trace) ticksTrace.push({ tick, atMs: now, depth: queue.length, starved: starved > starvedBefore, seq: appliedThisTick, target: reportedTarget });
    if (opts.serverTickMs) serverStart[tick + 1] = now + opts.serverTickMs(tick);
    tick += 1;
  };

  while (clientMs < endMs) {
    // Server ticks up to the client's now.
    while (serverAt(tick) <= clientMs) serverTick();
    // Snapshots that reached the client.
    down.sort((a, b) => a.at - b.at);
    while (down.length && down[0].at <= clientMs) {
      const s = down.shift()!;
      if (s.ack !== null) while (pending.length && !newer(pending[0].seq, s.ack)) pending.shift();
      knownDepth = s.depth;
      knownTarget = s.target;
      serverSeen.push({ tick: s.tick, wallMs: s.wallMs });
      while (serverSeen.length > 2 && serverSeen[serverSeen.length - 1].wallMs - serverSeen[0].wallMs > 1000) serverSeen.shift();
    }
    // A frame: the bundler makes this frame's inputs on the (dilated) input clock.
    const frameMs = Math.max(0.5, opts.frames.next(r, clientMs));
    const target = knownTarget ?? opts.client.dilateToDepth;
    if (target !== undefined && knownDepth !== null) {
      const close = opts.client.dilateCloseSec;
      // The runtime's own rule, unless a sweep sets its time constant.
      simRate = 1;
      if (opts.client.followServerRate && serverSeen.length >= 2) {
        const [a, b] = [serverSeen[0], serverSeen[serverSeen.length - 1]];
        if (b.wallMs > a.wallMs) simRate = ((b.tick - a.tick) * TICK_MS) / (b.wallMs - a.wallMs);
      }
      if (close === undefined) {
        // The runtime's own rule (bounded, at the server's rate).
        dilation = inputClockRate({ depth: knownDepth, target }, simRate);
      } else {
        dilation = Math.max(0, 1 + (target - knownDepth) / (60 * close));
        const bound = opts.client.maxRateDeviation;
        if (bound !== undefined) dilation = Math.min(1 + bound, Math.max(1 - bound, dilation));
        dilation *= simRate;
      }
    }
    // The client measures its frame on its own clock.
    const cmds = bundler.produce((frameMs * (opts.clientClockRate ?? 1) / 1000) * dilation, idle);
    if (opts.trace) framesTrace.push({ atMs: clientMs, rate: dilation, simRate, inputs: cmds.length });
    while (clientMs >= nextChangeMs) {
      control += 1;
      nextChangeMs += -Math.log(1 - rc()) * opts.controlChangeMeanMs!;
    }
    for (const c of cmds) {
      // A sequence number comes round again every 65,536 inputs (18 min).
      arrivedAt.delete(c.seq);
      appliedAt.delete(c.seq);
      applied.delete(c.seq);
      controlOf.set(c.seq, control);
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
  // Effective mispredictions: per tick, the controls applied against the
  // controls of the input a perfect pipeline would apply (the next in
  // sequence after the last that tick's real pipeline had reached).
  let effective = 0;
  if (opts.controlChangeMeanMs && appliedSeqs.length) {
    let expected: number | null = null;
    for (const [i, seq] of appliedSeqs.entries()) {
      if (seq === null) {
        // Starved: the last controls repeated; the perfect pipeline would
        // have applied the next input, if the driver had made it by then
        // (a stalled client made none: nothing to apply, nothing missed).
        const next = (expected ?? 0) + 1 & 0xffff;
        if (expected !== null && controlOf.has(next) && made.get(next)! <= appliedTickMs[i]) {
          const want = controlOf.get((expected + 1) & 0xffff)!;
          if (want !== controlOf.get(expected)) effective += 1;
        }
        continue;
      }
      if (expected !== null) {
        // Skipped inputs whose controls differed from what was applied.
        for (let s = (expected + 1) & 0xffff; s !== seq; s = (s + 1) & 0xffff) {
          if (controlOf.get(s) !== controlOf.get(seq)) { effective += 1; break; }
          if (((s - expected) & 0xffff) > 200) break;
        }
      }
      expected = seq;
    }
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
    effectivePerMin: effective / minutes,
    delayTicks: { p50: q(0.5), p95: q(0.95) },
    meanDepth: depthSum / Math.max(1, tick),
    depthBySecond,
    ...(opts.trace ? {
      ticksTrace,
      framesTrace,
      inputs: [...made].map(([seq, madeMs]) => ({ seq, madeMs, arrivedMs: arrivedAt.get(seq) ?? null, appliedMs: appliedAt.get(seq) ?? null })),
    } : {}),
  };
}

/**
 * The queue depth absorbing the `quantile` of lateness: arrival against
 * sequence, after the clock-rate trend when the window (`fitAt` inputs) is
 * full. Mirrors `ArrivalJitter::target` (server) when `fitAt` is the window;
 * `Infinity` is the first version (no trend removed, ceiling).
 */
export function jitterTarget(arrivals: [number, number][], quantile: number, fitAt: number, fit: 'lp' | 'lsq' = 'lp'): number {
  const n = arrivals.length;
  const [x0, y0] = arrivals[0];
  let slope = 1;
  if (n >= fitAt && fit === 'lsq') {
    const mx = arrivals.reduce((a, [x]) => a + x - x0, 0) / n;
    const my = arrivals.reduce((a, [, y]) => a + y - y0, 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of arrivals) { sxy += (x - x0 - mx) * (y - y0 - my); sxx += (x - x0 - mx) ** 2; }
    if (sxx > 0) slope = sxy / sxx;
  } else if (n >= fitAt) {
    slope = lowerBoundSlope(arrivals.map(([x, y]) => [x - x0, y - y0]));
  }
  const lateness = arrivals.map(([x, y]) => y - y0 - slope * (x - x0)).sort((a, b) => a - b);
  const spread = lateness[Math.min(n - 1, Math.floor(quantile * n))] - lateness[0];
  return fitAt === Infinity ? Math.ceil(spread) : Math.round(spread);
}

/**
 * Clock skew by Moon, Skelly and Towsley's linear program: the line under
 * every (sequence, arrival) point closest to them in sum, which lies on an
 * edge of their lower convex hull, the edge spanning the mean sequence. Late
 * arrivals lie above it and cannot tilt it (least squares can). `points`
 * sorted by x.
 */
export function lowerBoundSlope(points: [number, number][]): number {
  const hull: [number, number][] = [];
  for (const p of points) {
    while (hull.length >= 2) {
      const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]];
      // Drop b unless it turns counterclockwise (stays below a-p).
      if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0) hull.pop(); else break;
    }
    hull.push(p);
  }
  if (hull.length < 2) return 1;
  const mean = points.reduce((s, [x]) => s + x, 0) / points.length;
  for (let i = 0; i + 1 < hull.length; i++) {
    if (hull[i + 1][0] >= mean) return (hull[i + 1][1] - hull[i][1]) / (hull[i + 1][0] - hull[i][0]);
  }
  const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]];
  return (b[1] - a[1]) / (b[0] - a[0]);
}

/** The shipping pipeline (2026-10-11). */
export const SHIPPING = { client: { resend: 3 } as ClientPolicy, server: { accept: 'received', collapseAt: 4 } as ServerPolicy };
/**
 * VIBE_VEHICLE_INPUT_PACING as built: the client resends all unacked inputs
 * and runs its input clock at the server's rate, corrected within 5%; the
 * server queues in order, sizes its target from a sample a packet with the
 * clock's rate removed, and drops backlog beyond target + 3.
 */
export const PACED = {
  client: { resend: 'all', cap: INPUT_BUNDLE_MAX_FRAMES, followServerRate: true } as ClientPolicy,
  server: {
    accept: 'applied', targetQuantile: 0.95, jitterWindow: 120, removeSkew: true, samplePerPacket: true, dropBeyondTarget: 3,
  } as ServerPolicy,
};
/**
 * Paced as committed before the scenario suite (commit b0b3e846): unbounded
 * clock, every input sampled, least-squares skew removal, no backlog drop.
 */
export const PACED_FIRST = {
  client: { resend: 'all', cap: INPUT_BUNDLE_MAX_FRAMES, dilateCloseSec: 1 } as ClientPolicy,
  server: { accept: 'applied', targetQuantile: 0.95, jitterWindow: 120, removeSkew: true, skewFit: 'lsq' } as ServerPolicy,
};
