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
}

export interface PipelineStage {
  /** Draw. Return false when nothing was drawn; the composite then ignores output(). */
  render(ctx: PipelineStageContext): boolean;
  /** Premultiplied RGBA, full drawing-buffer size, or null. */
  output(): THREE.Texture | null;
  resize(width: number, height: number): void;
  dispose(): void;
}

const stages = new Set<PipelineStage>();
const listeners = new Set<() => void>();

/** Adds a stage; returns the remover. Stages draw in registration order. */
export function registerPipelineStage(stage: PipelineStage): () => void {
  stages.add(stage);
  for (const listener of listeners) listener();
  return () => {
    stages.delete(stage);
    for (const listener of listeners) listener();
  };
}

export function pipelineStages(): Iterable<PipelineStage> {
  return stages;
}

export function pipelineStageCount(): number {
  return stages.size;
}

/** Notified when a stage comes or goes. */
export function onPipelineStagesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
