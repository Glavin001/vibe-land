// Passes that draw after the scene and before the composite.
//
// The frame pipeline renders the scene into an offscreen beauty target with a
// depth texture, and anything that needs that depth -- SSAO, the volumetric
// dust -- runs as a stage here, reading the depth and writing its own target
// for the composite to lay over the picture. A stage can also decline to draw
// (no live dust, say), in which case the composite skips it and the frame
// costs nothing extra.
//
// A module-level registry rather than React context: the pipeline sits in a
// 3,400-line scene component and threading a provider through it for one
// consumer is more coupling than one Set.
//
// Two stages today: the dust and the meteor fire. They chain: each is handed
// the previous one's output as `under` and lays itself over it, so the
// composite still reads one texture.

import type * as THREE from 'three';

export interface PipelineStageContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  scene: THREE.Scene;
  /** The scene as rendered this frame. Its depthTexture is valid; do not draw into it. */
  beauty: THREE.WebGLRenderTarget;
  /** Drawing-buffer size, px. */
  width: number;
  height: number;
  /** Seconds since the previous frame, clamped. */
  dt: number;
  /**
   * What the stages before this one drew, premultiplied, or null when none
   * did. A stage that draws must lay itself over this: the composite takes
   * only the last output, so each stage carries the ones before it.
   */
  under: StageOutput | null;
}

/** A stage's layer, premultiplied RGBA. */
export interface StageOutput {
  texture: THREE.Texture;
  /**
   * Set when the texture is half the drawing buffer: the reader lays it up
   * with `dustUpsample` (dustVolumeShaders.UPSAMPLE_GLSL), depth-aware, in
   * its own pass -- a pass the stage did not have to spend on it.
   */
  halfSize: THREE.Vector2 | null;
}

export interface PipelineStage {
  /**
   * Draw order, low first; equal orders keep registration order. The dust is
   * 0 and ignores `under`, so anything that lays over it must come later.
   */
  order?: number;
  /** Draw. Return false when nothing was drawn; the composite then ignores output(). */
  render(ctx: PipelineStageContext): boolean;
  /** What it drew this frame, or null. */
  output(): StageOutput | null;
  resize(width: number, height: number): void;
  dispose(): void;
}

const stages: PipelineStage[] = [];
const listeners = new Set<() => void>();

/** Adds a stage; returns the remover. Stages draw by `order`, then registration order. */
export function registerPipelineStage(stage: PipelineStage): () => void {
  stages.push(stage);
  stages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const listener of listeners) listener();
  return () => {
    const index = stages.indexOf(stage);
    if (index >= 0) stages.splice(index, 1);
    for (const listener of listeners) listener();
  };
}

export function pipelineStages(): Iterable<PipelineStage> {
  return stages;
}

export function pipelineStageCount(): number {
  return stages.length;
}

/** Notified when a stage comes or goes. */
export function onPipelineStagesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
