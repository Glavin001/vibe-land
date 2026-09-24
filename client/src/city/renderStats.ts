// Frame accounting for the stats panel: every millisecond the browser spends
// gets an owner, so "29 fps" is a breakdown rather than a mystery.
//
// The distinction that matters, and that the first version of this file got
// wrong: `frameTotalMs` is a rAF-to-rAF wall-clock delta -- it includes vsync
// wait, compositing, GC and any work the browser runs between frames (the
// datagram reader and its wasm decode land there). It is NOT main-thread CPU
// time, so it cannot be used to convict JavaScript. `cpuFrameMs` is the real
// CPU span: the first frame callback through the end of gl.render.
//
// Top-level phases are non-overlapping and sum to cpuFrameMs:
//   cpuFrame = gameWorld + cityFrame + glRender + unattributed
// with `debugE2e` nested inside gameWorld and sample/dirtyWrite/sphere/
// telemetry nested inside cityFrame, reported as "of which" rows.
export const renderStats = {
  drawCalls: 0,
  /** Multi-draw sub-draws the city submits per frame; set once at mesh build. */
  subDraws: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,

  /// rAF-to-rAF delta: the whole frame the user experiences.
  frameTotalMs: 0,
  /// Frame start through the end of gl.render -- main-thread CPU, the number a
  /// worker offload can actually shrink.
  cpuFrameMs: 0,
  /// frameTotal - cpuFrame: vsync idle plus whatever ran between frames
  /// (`decodeMs` is the measured part of it). Healthy headroom shows up here.
  offFrameMs: 0,
  /// cpuFrame minus every named phase: the to-do list for instrumentation.
  unattributedMs: 0,

  /// Time inside WebGLRenderer.render itself -- includes BatchedMesh data-
  /// texture uploads, the suspect invisible to call/triangle counters.
  glRenderMs: 0,
  /** Real GPU execution time, when the timer-query extension is available. */
  gpuFrameMs: 0,
  /**
   * GPU time of each `renderer.render()` call of the frame, in call order:
   * with the frame pipeline on that is scene (shadow map + beauty), AO, blur,
   * any dust stage renders, composite. They sum to gpuFrameMs. Exists because
   * a whole-frame number could not say WHICH pass grew when destruction did.
   * Six slots; a frame with more passes folds the rest into the last.
   */
  gpuPass0Ms: 0,
  gpuPass1Ms: 0,
  gpuPass2Ms: 0,
  gpuPass3Ms: 0,
  gpuPass4Ms: 0,
  gpuPass5Ms: 0,
  /// How many render() calls the measured frame issued.
  gpuPassCount: 0,
  /// GPU time of the dust stage's passes (fluid steps, volume, upsample) within gpuFrameMs.
  gpuDustMs: 0,
  /// Everything the frame runs before the city layer: GameWorld's callback
  /// (input, prediction, camera, entity sync) plus the small scene extras.
  /// Measured as a span rather than bracketed inside GameWorld because that
  /// callback has a dozen early returns.
  beforeCityMs: 0,
  /// CityChunksLayer's per-frame callback in full.
  cityFrameMs: 0,

  /// Nested in beforeCity: debug-stats payload build + e2e bridge push.
  debugE2eMs: 0,
  /// Nested in cityFrame: pose sampling/interpolation for live bodies.
  sampleMs: 0,
  /// Nested in cityFrame: the dirty-body matrix/colour write loop.
  dirtyWriteMs: 0,
  /// Nested in cityFrame: per-batch bounding-sphere recompute.
  sphereMs: 0,
  /// Nested in cityFrame: the 2 Hz telemetry/invariant sweeps.
  telemetryMs: 0,
  /// Chunk records (body + offset) rewritten this frame, and what that cost.
  recordWrites: 0,
  recordWriteMs: 0,
  /// Nested in cityFrame: this frame's slice of the diagnostic position sweep.
  sweepSliceMs: 0,
  /// Dynamic resolution: the multiplier currently applied under the tier's dpr (1 = full).
  dprScale: 1,
  /// The GPU budget the resolution controller is holding the frame to, ms.
  gpuBudgetMs: 0,
  /// The dust governor's current trims: sample-budget multiplier and fluid cap (0 off, 1 fast, 2 balanced).
  governorSampleScale: 1,
  governorFluidCap: 2,
  governorDustSprites: 0,
  /// 1 while the governor has the beauty target's multisampling off.
  governorMsaaOff: 0,

  /// Stream decode accumulated between the previous frame and this one. Runs
  /// in the datagram reader's microtasks, so it lands in offFrame, not cpuFrame.
  decodeMs: 0,

  /// Chunks culled for being under the world since load. Non-zero means the
  /// hide heuristic fired, which is worth knowing: it is the only thing that
  /// makes geometry disappear, so a hole in a building starts here.
  chunksHidden: 0,

  /// Chunks that came BACK from being hidden. The counterpart to the line
  /// above and, until it existed, the missing half of the only mechanism in
  /// this renderer that makes geometry disappear: hiding was counted,
  /// un-hiding was not, so a chunk flickering out and back looked identical to
  /// one that had genuinely escaped the world. A player watching a large
  /// structure come down described it as parts of the building phasing in and
  /// out, which is this pair of numbers both climbing together.
  chunksUnhidden: 0,

  /// Render cells the frustum test rejects this frame, and how many chunks
  /// written this frame were inside them. A cell culled while holding moving
  /// geometry is the case where a whole block can vanish on screen while the
  /// player is looking straight at it -- three does this test inside the
  /// renderer and reports nothing, so it is replicated to be counted.
  cellsCulled: 0,
  culledLiveChunks: 0,
  worstCulledLiveChunks: 0,
  worstCulledAabbM: 0,

  /// Chunks that left the static shell for their own instance. The single
  /// moment a chunk changes which object draws it, and so the one place a
  /// chunk could be drawn twice or not at all.
  shellWakes: 0,

  /// Live bodies whose chunks were NOT rewritten this frame, because the
  /// distance stride deferred them, and the chunks that involved. By design
  /// and invisible at a few frames; counted because the design assumes a body
  /// is written often and a starved one is not.
  staleLiveBodies: 0,
  staleLiveChunks: 0,

  /// Currently hidden, recomputed on the telemetry sweep rather than tracked
  /// per write, because the interesting question is how much of the city is
  /// invisible right now and not how it got there.
  chunksHiddenNow: 0,

  /// The largest number of chunks belonging to ONE body that were hidden
  /// together, ever. One chunk vanishing is a speck; eight hundred vanishing
  /// at once is half a building disappearing for a moment.
  worstBodyHiddenChunks: 0,

  /// Chunk writes skipped because the ledger could not resolve the chunk's
  /// body. Cumulative. Must stay 0: every one is a frame where a chunk had no
  /// known pose, and before this it was drawn at its body-local offset --
  /// effectively at the world origin.
  chunksUnresolved: 0,

  /// Chunk instances written (matrix+color) this frame; frozen chunks should
  /// make this small, and a large number with low triangles convicts upload
  /// bandwidth.
  instanceWrites: 0,

  // -- Destruction dust ------------------------------------------------------
  /// Parcels alive in the store, and how many of them this frame drew, in the
  /// full-res and the half-res layer.
  dustParcelsLive: 0,
  dustDrawn: 0,
  dustDrawnHalf: 0,
  /// Σ pixels·steps the volume pass was asked for, millions. The budget is
  /// what holds it: if this sits at the budget the frame is dust-bound.
  dustSamplesEstM: 0,
  /// CPU inside the dust layer: emission (source drain + policy) and the
  /// renderer's selection/upload, both nested in cityFrame's frame.
  dustEmitMs: 0,
  dustCpuMs: 0,
  /// Parcels spawned, cumulative, and what never became one: per-tick cap,
  /// palette, queue overflow.
  dustEmitted: 0,
  dustDropped: 0,
  /// 1 when the volume pass did not run this frame (nothing to draw).
  dustPassSkipped: 1,
  /// The meteor fire pass, CPU-side ms per frame; 0 when no meteor is live.
  meteorFireMs: 0,
  /// Meteors being drawn this frame, streamed or on their predicted arc.
  meteorsLive: 0,
  /// Fluid bricks live this frame.
  dustFluidActive: 0,
  /// Last rebuild of the wall-occupancy volume the march samples, ms CPU.
  dustOccupancyMs: 0,
  /// Moving bodies pushing the dust this frame.
  dustMovers: 0,
};

let lastRafStamp = 0;
let frameStartedAt = 0;
let decodeAccumMs = 0;

/// Called by the stream client each time a packet is decoded. The cost is
/// off-frame, so it is accumulated and attributed to the next frame.
export function addDecodeMs(ms: number): void {
  decodeAccumMs += ms;
}

/**
 * First thing in the frame: close out the previous frame's derived numbers and
 * start this one's CPU clock. Must run before every other useFrame subscriber
 * (mount FrameClock with a negative render priority -- R3F sorts subscribers
 * ascending and only a *positive* priority disables its automatic render).
 */
export function markFrameStart(): void {
  // Collect the GPU results that have landed and open this frame's pass
  // numbering before anything this frame submits.
  startGpuFrame();
  const now = performance.now();
  if (lastRafStamp > 0) {
    renderStats.frameTotalMs = now - lastRafStamp;
    renderStats.offFrameMs = Math.max(0, renderStats.frameTotalMs - renderStats.cpuFrameMs);
    renderStats.unattributedMs = Math.max(
      0,
      renderStats.cpuFrameMs
        - renderStats.glRenderMs
        - renderStats.beforeCityMs
        - renderStats.cityFrameMs,
    );
  }
  lastRafStamp = now;
  frameStartedAt = now;
  renderStats.debugE2eMs = 0;
  renderStats.decodeMs = decodeAccumMs;
  decodeAccumMs = 0;
}

/// When the current frame's CPU clock opened, for spans measured against it.
export function frameStartTime(): number {
  return frameStartedAt;
}

/// Accumulates the debug/e2e payload brackets, which are several blocks inside
/// one callback rather than a single span.
export function addDebugE2eMs(ms: number): void {
  renderStats.debugE2eMs += ms;
}

/**
 * Per-frame render totals, accumulated across however many passes ran.
 *
 * A frame is no longer one `render()` call. With SSAO on -- the PRETTY default
 * -- `FramePipeline` takes the loop over and issues four: the scene into a
 * target, then AO, blur and composite quads. three clears `info.render` at the
 * top of every one of them, so whatever reads the counters afterwards sees the
 * composite quad alone: the panel and `city-frame-profile` both reported 1 draw
 * call and 2 triangles for a 41k-chunk city, and `glRenderMs` timed a
 * fullscreen quad instead of the scene.
 *
 * `calls`/`triangles` take the PEAK across the frame's passes rather than the
 * sum, which keeps them meaning what they have always meant: the scene pass.
 * (Not the shadow pass -- three resets after that and before the main one, so
 * it has never been counted here. Summing would have quietly folded it in and
 * broken comparison with every number recorded before this.) `glRenderMs`
 * takes the SUM, because every pass is real submit time the frame paid.
 */
let peakCalls = 0;
let peakTriangles = 0;
let renderMsThisFrame = 0;

// ---------------------------------------------------------------------------
// GPU time
//
// Everything else here is CPU: `glRenderMs` is how long the render CALLS took
// to return, which is submission, not execution. A frame can submit in 2 ms and
// take 18 ms on the GPU, and from the CPU side that is indistinguishable from
// sitting idle waiting for vsync -- both land in `offFrameMs`. That ambiguity
// is not academic: it is exactly how a change that multiplied per-pixel work
// got measured as free on a GPU fast enough to hide it.
//
// EXT_disjoint_timer_query_webgl2 gives the real number. One query brackets
// each `renderer.render()` call -- the scene pass, then whatever the frame
// pipeline adds behind three's back -- so the frame's GPU time comes back
// per pass (`gpuPassMs`) as well as in total. Results land a few frames
// later, which is why they are polled rather than awaited. Per pass rather
// than per frame because on a GPU shared with other processes the whole-frame
// number includes their work; the minimum of a pass over many frames does not.
//
// Caveat, measured on an M3 Max through ANGLE's Metal backend: the passes of
// a 12 ms frame summed to 26-52 ms. Metal's timer queries there report
// something wider than the bracketed pass (command-buffer granularity, most
// likely), so on that platform the per-pass numbers rank the passes but do
// not add up to the frame. Nothing here should decide "over budget" from
// them alone; the governor decides that from frame pacing.
// ---------------------------------------------------------------------------

type TimerExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

let gl2: WebGL2RenderingContext | null = null;
let timerExt: TimerExt | null = null;
const freeQueries: WebGLQuery[] = [];
// One query per render() call, tagged with the frame it belongs to and its
// position in that frame. Results come back in issue order a few frames later.
type PassQuery = { query: WebGLQuery; frame: number; pass: number };
const pendingQueries: PassQuery[] = [];
let frameSerial = 0;
let passesThisFrame = 0;
// Per-frame results being assembled: pass ms by index, and how many passes the
// frame issued, so a frame publishes once every one of its passes is in.
let assembling: { frame: number; ms: number[]; issued: number } | null = null;
const passesIssuedByFrame = new Map<number, number>();
/**
 * Frame -> pass ranges [first, one past last) issued by pipeline stages, for
 * gpuDustMs. Several stages run per frame (the dust volume, the meteor fire);
 * every stage's range counts, so the number is "the stages", dust foremost.
 */
const dustRangeByFrame = new Map<number, Array<[number, number]>>();
let dustStageStart = -1;

/**
 * Called with each frame's GPU time once every pass of it has resolved:
 * `frame` is the serial the frame was drawn under (`currentGpuFrameSerial()`
 * while it ran), `totalMs` the sum of its passes (`gpuFrameMs`), `maxPassMs`
 * its longest pass. Frames lost to a disjoint or the backlog cap are never
 * reported. The city tape recorder uses this to put each frame's own GPU time
 * on the frame it belongs to, although it arrives a few frames later.
 */
export type GpuFrameListener = (frame: number, totalMs: number, maxPassMs: number) => void;
const gpuFrameListeners = new Set<GpuFrameListener>();

export function onGpuFrameResult(listener: GpuFrameListener): () => void {
  gpuFrameListeners.add(listener);
  return () => {
    gpuFrameListeners.delete(listener);
  };
}

/**
 * Where GPU frame times went, cumulative since the page loaded: frames whose
 * every pass resolved, disjoint events (each discards every result in
 * flight) and the queries they threw away, frames that expired before their
 * results arrived, and how many frames late the resolved ones landed. A tape
 * records the change over its recording, so a tape with few timed frames
 * says why.
 */
const gpuCounters = {
  framesResolved: 0,
  disjoints: 0,
  queriesDiscarded: 0,
  framesExpired: 0,
  queriesRefused: 0,
  lagFramesMax: 0,
  lagFramesSum: 0,
};
export type GpuTimerCounters = typeof gpuCounters;

export function gpuTimerCounters(): GpuTimerCounters {
  return { ...gpuCounters };
}

/**
 * How long a frame's GPU passes may take to resolve before the frame is
 * given up on, in frames. Was 64 (0.5 s at 120 Hz); a GPU shared with the
 * city server's step can hold results back longer than that, and a frame
 * pruned from the issue table can never publish.
 */
const GPU_FRAME_WINDOW = 600;

/** The serial of the frame being drawn now; the one that just ended is one less. */
export function currentGpuFrameSerial(): number {
  return frameSerial;
}

/**
 * Whether frames get GPU times: 'unknown' until the renderer has been patched
 * (its first frame), then the extension's name or 'unavailable'.
 */
export function gpuTimerStatus(): 'EXT_disjoint_timer_query_webgl2' | 'unavailable' | 'unknown' {
  if (!patched) return 'unknown';
  return timerExt ? 'EXT_disjoint_timer_query_webgl2' : 'unavailable';
}

function drainGpuQueries(): void {
  if (!gl2 || !timerExt) return;
  // A disjoint means the GPU was interrupted (clock change, context switch) and
  // every in-flight result is garbage. Throw them all away rather than report a
  // number that is wrong in an unknowable direction.
  if (gl2.getParameter(timerExt.GPU_DISJOINT_EXT)) {
    gpuCounters.disjoints += 1;
    gpuCounters.queriesDiscarded += pendingQueries.length;
    for (const entry of pendingQueries) freeQueries.push(entry.query);
    pendingQueries.length = 0;
    assembling = null;
    passesIssuedByFrame.clear();
    return;
  }
  while (pendingQueries.length > 0) {
    const entry = pendingQueries[0];
    if (!gl2.getQueryParameter(entry.query, gl2.QUERY_RESULT_AVAILABLE)) break;
    pendingQueries.shift();
    const ms = gl2.getQueryParameter(entry.query, gl2.QUERY_RESULT) / 1e6;
    freeQueries.push(entry.query);
    if (!assembling || assembling.frame !== entry.frame) {
      assembling = { frame: entry.frame, ms: [], issued: passesIssuedByFrame.get(entry.frame) ?? 0 };
    }
    assembling.ms[entry.pass] = ms;
    if (assembling.ms.length >= assembling.issued && assembling.issued > 0) {
      let total = 0;
      let maxPass = 0;
      const slots = [0, 0, 0, 0, 0, 0];
      assembling.ms.forEach((v, index) => {
        total += v || 0;
        if ((v || 0) > maxPass) maxPass = v || 0;
        slots[Math.min(index, slots.length - 1)] += v || 0;
      });
      gpuCounters.framesResolved += 1;
      const lag = frameSerial - entry.frame;
      gpuCounters.lagFramesSum += lag;
      if (lag > gpuCounters.lagFramesMax) gpuCounters.lagFramesMax = lag;
      for (const listener of gpuFrameListeners) listener(entry.frame, total, maxPass);
      renderStats.gpuPass0Ms = slots[0];
      renderStats.gpuPass1Ms = slots[1];
      renderStats.gpuPass2Ms = slots[2];
      renderStats.gpuPass3Ms = slots[3];
      renderStats.gpuPass4Ms = slots[4];
      renderStats.gpuPass5Ms = slots[5];
      renderStats.gpuPassCount = assembling.ms.length;
      renderStats.gpuFrameMs = total;
      const ranges = dustRangeByFrame.get(entry.frame);
      let dustMs = 0;
      if (ranges) {
        for (const [from, to] of ranges) {
          for (let i = from; i < to && i < assembling.ms.length; i += 1) dustMs += assembling.ms[i] || 0;
        }
        dustRangeByFrame.delete(entry.frame);
      }
      renderStats.gpuDustMs = dustMs;
      passesIssuedByFrame.delete(entry.frame);
      assembling = null;
    }
  }
}

function beginPassQuery(): WebGLQuery | null {
  if (!gl2 || !timerExt) return null;
  // Cap the backlog: if results stop arriving, stop allocating queries.
  if (pendingQueries.length > 1024) {
    gpuCounters.queriesRefused += 1;
    return null;
  }
  const query = freeQueries.pop() ?? gl2.createQuery();
  if (!query) return null;
  gl2.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
  return query;
}

function endPassQuery(query: WebGLQuery | null): void {
  if (!gl2 || !timerExt || !query) return;
  gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
  pendingQueries.push({ query, frame: frameSerial, pass: passesThisFrame });
  passesThisFrame += 1;
  passesIssuedByFrame.set(frameSerial, passesThisFrame);
}

/** Called at the top of every frame: results of earlier frames are collected here. */
function startGpuFrame(): void {
  drainGpuQueries();
  frameSerial += 1;
  passesThisFrame = 0;
  // Frames that never resolved (a query lost to the backlog cap) would pin the
  // map forever; anything older than the pending window is gone.
  if (passesIssuedByFrame.size > 2 * GPU_FRAME_WINDOW) {
    for (const key of passesIssuedByFrame.keys()) {
      if (key < frameSerial - GPU_FRAME_WINDOW) {
        passesIssuedByFrame.delete(key);
        gpuCounters.framesExpired += 1;
      }
    }
    for (const key of dustRangeByFrame.keys()) {
      if (key < frameSerial - GPU_FRAME_WINDOW) dustRangeByFrame.delete(key);
    }
  }
}

/** Bracket the render() calls a pipeline stage issues, so their GPU time reports separately. */
export function beginGpuDustStage(): void {
  dustStageStart = passesThisFrame;
}

export function endGpuDustStage(): void {
  if (dustStageStart < 0) return;
  if (passesThisFrame > dustStageStart) {
    const ranges = dustRangeByFrame.get(frameSerial) ?? [];
    ranges.push([dustStageStart, passesThisFrame]);
    dustRangeByFrame.set(frameSerial, ranges);
  }
  dustStageStart = -1;
}

let patched = false;
export function patchRendererTiming(gl: { render: (...args: never[]) => void }): void {
  if (patched) return;
  patched = true;
  const original = gl.render.bind(gl);
  const info = (gl as { info?: { render: { calls: number; triangles: number } } }).info;
  const context = (gl as { getContext?: () => WebGLRenderingContext | WebGL2RenderingContext })
    .getContext?.();
  if (context && 'createQuery' in context) {
    gl2 = context as WebGL2RenderingContext;
    timerExt = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  }
  (gl as { render: (...args: never[]) => void }).render = (...args: never[]) => {
    const started = performance.now();
    const query = beginPassQuery();
    original(...args);
    endPassQuery(query);
    const ended = performance.now();
    renderMsThisFrame += ended - started;
    if (info && info.render.calls > peakCalls) {
      peakCalls = info.render.calls;
      peakTriangles = info.render.triangles;
    }
    // The last render of a frame closes the CPU span, without needing a
    // separate end-of-frame subscriber. Overwritten by each pass; the last one
    // wins, which is what we want.
    renderStats.cpuFrameMs = ended - frameStartedAt;
  };
}

/**
 * Publish the completed frame's totals and arm the next one.
 *
 * Called at the TOP of the city layer's frame callback, which runs before any
 * rendering, so the accumulators still hold the previous frame.
 */
export function markFrameEndAndSample(info: {
  render: { calls: number; triangles: number };
  memory: { geometries: number; textures: number };
}): void {
  // Falls back to the live counters when nothing patched the renderer, which is
  // the case in tests and in RenderBench.
  renderStats.drawCalls = peakCalls || info.render.calls;
  renderStats.triangles = peakTriangles || info.render.triangles;
  if (renderMsThisFrame > 0) renderStats.glRenderMs = renderMsThisFrame;
  peakCalls = 0;
  peakTriangles = 0;
  renderMsThisFrame = 0;
  renderStats.geometries = info.memory.geometries;
  renderStats.textures = info.memory.textures;
}
