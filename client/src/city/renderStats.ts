// Renderer-side counters for the stats panel, filled once per frame from
// WebGLRenderer.info. Exists because "29 fps" cannot be attributed: chunk
// update is 2 ms, so the frame is going to draw calls, triangles, or React
// orchestration -- and only the renderer knows which. Mobile GPUs expose no
// timer queries, so triangle/call counts are the best available proxy for
// GPU load; cpuRenderMs brackets the whole R3F render pass on the CPU side.
export const renderStats = {
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  /// CPU time inside the last requestAnimationFrame tick (three render +
  /// React work), measured by the frame wrapper below.
  cpuFrameMs: 0,
  /// Time inside WebGLRenderer.render itself -- includes BatchedMesh data-
  /// texture uploads, the suspect invisible to call/triangle counters.
  glRenderMs: 0,
  /// Chunk instances written (matrix+color) this frame; frozen chunks should
  /// make this small, and a large number with low triangles convicts upload
  /// bandwidth.
  instanceWrites: 0,
  /// RAF-to-RAF delta: the whole frame the user experiences.
  frameTotalMs: 0,
  /// frameTotal - gl.render - chunk update: everything not yet bracketed
  /// (stream decode, interpolation/compose, React, browser scheduling).
  /// This row is the to-do list: shrinking it means adding brackets until
  /// every millisecond has an owner.
  unattributedMs: 0,
};
let lastRafStamp = 0;
export function sampleFrameTotals(chunkUpdateMs: number): void {
  const now = performance.now();
  if (lastRafStamp > 0) {
    renderStats.frameTotalMs = now - lastRafStamp;
    renderStats.unattributedMs = Math.max(
      0,
      renderStats.frameTotalMs - renderStats.glRenderMs - chunkUpdateMs,
    );
  }
  lastRafStamp = now;
}

let patched = false;
export function patchRendererTiming(gl: { render: (...args: never[]) => void }): void {
  if (patched) return;
  patched = true;
  const original = gl.render.bind(gl);
  (gl as { render: (...args: never[]) => void }).render = (...args: never[]) => {
    const started = performance.now();
    original(...args);
    renderStats.glRenderMs = performance.now() - started;
  };
}

let lastFrameStart = 0;

export function markFrameStart(): void {
  lastFrameStart = performance.now();
}

export function markFrameEndAndSample(info: {
  render: { calls: number; triangles: number };
  memory: { geometries: number; textures: number };
}): void {
  renderStats.cpuFrameMs = performance.now() - lastFrameStart;
  renderStats.drawCalls = info.render.calls;
  renderStats.triangles = info.render.triangles;
  renderStats.geometries = info.memory.geometries;
  renderStats.textures = info.memory.textures;
}
