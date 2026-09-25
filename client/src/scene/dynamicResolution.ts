// Where the render governor's resolution scale is applied.
//
// With the frame pipeline mounted, the canvas keeps the tier's pixel ratio
// and the pipeline renders at `scale` of its drawing buffer (the composite
// lays it up to the canvas); a governor step then resizes offscreen targets
// only. Resizing the canvas reallocates the WebGL drawing buffer
// synchronously, which with the GPU shared with the city server stalled the
// frame 25-100 ms per step (docs/city-bench.md, "Client hitches"). Without a
// pipeline nothing renders offscreen, so the canvas itself is scaled.

export interface ResolutionPlan {
  /** The pixel ratio the canvas should have. */
  canvasDpr: number;
  /** The fraction of the drawing buffer the frame pipeline renders at. */
  pipelineScale: number;
}

export function resolutionPlan(scale: number, baseDpr: number, pipelineMounted: boolean): ResolutionPlan {
  return pipelineMounted
    ? { canvasDpr: baseDpr, pipelineScale: scale }
    : { canvasDpr: baseDpr * scale, pipelineScale: 1 };
}

/** Whether moving the canvas from `current` to `next` pixel ratio is a resize. */
export function canvasDprChanges(current: number, next: number): boolean {
  return Math.abs(current - next) > 1e-6;
}
