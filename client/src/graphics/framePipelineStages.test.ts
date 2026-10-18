import { describe, expect, it } from 'vitest';
import {
  framePipelineMounted,
  framePipelineResolutionScale,
  holdFramePipelineMounted,
  setFramePipelineResolutionScale,
} from './framePipelineStages';

describe('frame pipeline resolution scale', () => {
  it('clamps to (0, 1] and falls back to 1', () => {
    setFramePipelineResolutionScale(0.6);
    expect(framePipelineResolutionScale()).toBe(0.6);
    setFramePipelineResolutionScale(3);
    expect(framePipelineResolutionScale()).toBe(1);
    setFramePipelineResolutionScale(Number.NaN);
    expect(framePipelineResolutionScale()).toBe(1);
    setFramePipelineResolutionScale(0);
    expect(framePipelineResolutionScale()).toBeGreaterThan(0);
    setFramePipelineResolutionScale(1);
  });

  it('counts mounts, and a double release is ignored', () => {
    expect(framePipelineMounted()).toBe(false);
    const a = holdFramePipelineMounted();
    const b = holdFramePipelineMounted();
    expect(framePipelineMounted()).toBe(true);
    a();
    a();
    expect(framePipelineMounted()).toBe(true);
    b();
    expect(framePipelineMounted()).toBe(false);
  });
});
