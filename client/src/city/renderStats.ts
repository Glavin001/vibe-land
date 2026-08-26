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

  /// Stream decode accumulated between the previous frame and this one. Runs
  /// in the datagram reader's microtasks, so it lands in offFrame, not cpuFrame.
  decodeMs: 0,

  /// Chunks culled for being under the world since load. Non-zero means the
  /// hide heuristic fired, which is worth knowing: it is the only thing that
  /// makes geometry disappear, so a hole in a building starts here.
  chunksHidden: 0,

  /// Chunk writes skipped because the ledger could not resolve the chunk's
  /// body. Cumulative. Must stay 0: every one is a frame where a chunk had no
  /// known pose, and before this it was drawn at its body-local offset --
  /// effectively at the world origin.
  chunksUnresolved: 0,

  /// Chunk instances written (matrix+color) this frame; frozen chunks should
  /// make this small, and a large number with low triangles convicts upload
  /// bandwidth.
  instanceWrites: 0,
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
 * -- `AmbientOcclusion` takes the loop over and issues four: the scene into a
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

let patched = false;
export function patchRendererTiming(gl: { render: (...args: never[]) => void }): void {
  if (patched) return;
  patched = true;
  const original = gl.render.bind(gl);
  const info = (gl as { info?: { render: { calls: number; triangles: number } } }).info;
  (gl as { render: (...args: never[]) => void }).render = (...args: never[]) => {
    const started = performance.now();
    original(...args);
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
