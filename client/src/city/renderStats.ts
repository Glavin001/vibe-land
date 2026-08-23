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

let patched = false;
export function patchRendererTiming(gl: { render: (...args: never[]) => void }): void {
  if (patched) return;
  patched = true;
  const original = gl.render.bind(gl);
  (gl as { render: (...args: never[]) => void }).render = (...args: never[]) => {
    const started = performance.now();
    original(...args);
    const ended = performance.now();
    renderStats.glRenderMs = ended - started;
    // gl.render is the last thing R3F does in the frame, so this closes the
    // CPU span without needing a separate end-of-frame subscriber.
    renderStats.cpuFrameMs = ended - frameStartedAt;
  };
}

export function markFrameEndAndSample(info: {
  render: { calls: number; triangles: number };
  memory: { geometries: number; textures: number };
}): void {
  renderStats.drawCalls = info.render.calls;
  renderStats.triangles = info.render.triangles;
  renderStats.geometries = info.memory.geometries;
  renderStats.textures = info.memory.textures;
}
