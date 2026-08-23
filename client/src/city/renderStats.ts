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
};

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
