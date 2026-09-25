import { describe, expect, it } from 'vitest';
import { canvasDprChanges, resolutionPlan } from './dynamicResolution';

// The governor's trim ladder: 8% a step down to 0.6, and its probes back up.
const LADDER = [1, 0.92, 0.8464, 0.778688, 0.71639296, 0.6590815232, 0.606355001344, 0.6];

describe('resolutionPlan', () => {
  it('never resizes the canvas for a governor step while the pipeline is mounted', () => {
    // The regression this guards: every 8% step resized the canvas, and a
    // canvas resize reallocates the drawing buffer synchronously (25-100 ms
    // a step on the city bench while the server shared the GPU).
    for (const base of [1, 1.5, 2]) {
      let dpr = resolutionPlan(1, base, true).canvasDpr;
      let resizes = 0;
      for (const scale of [...LADDER, ...[...LADDER].reverse()]) {
        const plan = resolutionPlan(scale, base, true);
        if (canvasDprChanges(dpr, plan.canvasDpr)) resizes += 1;
        dpr = plan.canvasDpr;
        expect(plan.pipelineScale).toBe(scale);
      }
      expect(resizes).toBe(0);
    }
  });

  it('renders the same pixel count either way', () => {
    for (const scale of LADDER) {
      const piped = resolutionPlan(scale, 2, true);
      const direct = resolutionPlan(scale, 2, false);
      expect(piped.canvasDpr * piped.pipelineScale).toBeCloseTo(direct.canvasDpr * direct.pipelineScale, 12);
    }
  });

  it('scales the canvas when there is no pipeline to scale', () => {
    expect(resolutionPlan(0.6, 2, false)).toEqual({ canvasDpr: 1.2, pipelineScale: 1 });
    expect(resolutionPlan(1, 1.5, false)).toEqual({ canvasDpr: 1.5, pipelineScale: 1 });
  });

  it('moves the scale when the pipeline comes or goes', () => {
    // One resize each way, then steps are free again.
    expect(canvasDprChanges(resolutionPlan(0.6, 2, false).canvasDpr, resolutionPlan(0.6, 2, true).canvasDpr)).toBe(true);
    expect(canvasDprChanges(resolutionPlan(0.6, 2, true).canvasDpr, resolutionPlan(0.92, 2, true).canvasDpr)).toBe(false);
  });
});
