// The offscreen frame: scene into a beauty target with depth, then whatever
// needs that depth, then one composite quad to the canvas.
//
// Mounting this component takes over the render loop: R3F stops rendering
// automatically as soon as a `useFrame` callback with a positive priority
// exists. Unmounting hands rendering back. There must be exactly one of these;
// the scene mounts it whenever SSAO or the volumetric dust is on.
//
// SSAO lives here as a built-in pass because it was here first (this file is
// the generalisation of the old AmbientOcclusion.tsx); the dust registers
// itself as a stage (framePipelineStages.ts) because it comes and goes with
// the game world, not with the pipeline.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { aoMsaaSamplesSetting } from '../app/renderQuality';
import { beginGpuDustStage, endGpuDustStage, renderStats } from '../city/renderStats';
import {
  AO_FRAGMENT,
  BLUR_FRAGMENT,
  COMPOSITE_FRAGMENT,
  FULLSCREEN_VERTEX,
  buildKernel,
  makeTarget,
} from './aoPasses';
import { pipelineStages, pipelineStageCount, type StageOutput } from './framePipelineStages';
import { lookTuning, subscribeLookTuning } from './lookTuning';

type FramePipelineProps = {
  /** Run the SSAO passes. */
  ao: boolean;
  /** Sample radius in metres. Roughly the size of the crevices it can see. */
  aoRadius?: number;
  /** Exponent on the AO term. Higher = deeper contact shadows. */
  aoStrength?: number;
  /** View distance in metres where AO starts fading out, and where it is gone. */
  aoFadeStartM?: number;
  aoFadeEndM?: number;
};

export function FramePipeline({
  ao,
  aoRadius,
  aoStrength,
  aoFadeStartM = 60,
  aoFadeEndM = 140,
}: FramePipelineProps) {
  const gl = useThree((state) => state.gl);
  // Props win when given; otherwise the live store, so a tuning session can
  // sweep these at a parked camera instead of rebuilding per candidate.
  const tuning = lookTuning();
  const activeRadius = aoRadius ?? tuning.aoRadius;
  const activeStrength = aoStrength ?? tuning.aoStrength;

  const passes = useMemo(() => {
    const size = new THREE.Vector2();
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const aoMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uProj: { value: new THREE.Matrix4() },
        uInvProj: { value: new THREE.Matrix4() },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uFullResolution: { value: new THREE.Vector2(1, 1) },
        uKernel: { value: buildKernel() },
        uRadius: { value: activeRadius },
        uFadeStart: { value: aoFadeStartM },
        uFadeEnd: { value: aoFadeEndM },
      },
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: AO_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tAO: { value: null },
        tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    const compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tAO: { value: null },
        tDust: { value: null },
        tDepth: { value: null },
        uDustHalfSize: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
        uPower: { value: activeStrength },
        uAoOn: { value: 0 },
        uDustOn: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.PlaneGeometry(2, 2);
    const scenes = [aoMaterial, blurMaterial, compositeMaterial].map((material) => {
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(quad, material));
      return scene;
    });

    return {
      size,
      quadCamera,
      quad,
      aoMaterial,
      blurMaterial,
      compositeMaterial,
      aoScene: scenes[0],
      blurScene: scenes[1],
      compositeScene: scenes[2],
      beauty: null as THREE.WebGLRenderTarget | null,
      ao: null as THREE.WebGLRenderTarget | null,
      blur: null as THREE.WebGLRenderTarget | null,
      lastMs: 0,
    };
  }, [aoFadeStartM, aoFadeEndM]);

  useEffect(() => {
    return () => {
      passes.beauty?.dispose();
      passes.ao?.dispose();
      passes.blur?.dispose();
      passes.aoMaterial.dispose();
      passes.blurMaterial.dispose();
      passes.compositeMaterial.dispose();
      passes.quad.dispose();
      // Whoever renders next owns the canvas again.
      gl.setRenderTarget(null);
    };
  }, [passes, gl]);

  // Strength and radius are plain uniforms, so they retune in place. Kept out
  // of the memo above deliberately: rebuilding the passes for them would
  // reallocate three render targets mid-sweep and measure the reallocation.
  useEffect(() => {
    const apply = () => {
      const live = lookTuning();
      // uRadius is the AO pass's sample kernel; uPower is the exponent the
      // COMPOSITE pass applies. Different materials, and getting that wrong
      // throws on every retune.
      passes.aoMaterial.uniforms.uRadius.value = aoRadius ?? live.aoRadius;
      passes.compositeMaterial.uniforms.uPower.value = aoStrength ?? live.aoStrength;
    };
    apply();
    return subscribeLookTuning(apply);
  }, [passes, aoRadius, aoStrength]);

  // Priority 1: R3F hands the render loop over to this callback.
  useFrame(({ gl: renderer, scene, camera }) => {
    const drawing = renderer.getDrawingBufferSize(passes.size);
    const width = Math.max(2, Math.floor(drawing.x));
    const height = Math.max(2, Math.floor(drawing.y));
    const halfWidth = Math.max(1, width >> 1);
    const halfHeight = Math.max(1, height >> 1);

    const wantSamples = aoMsaaSamplesSetting();
    if (
      !passes.beauty
      || passes.beauty.width !== width
      || passes.beauty.height !== height
      || passes.beauty.samples !== wantSamples
    ) {
      passes.beauty?.dispose();
      passes.beauty = makeTarget(width, height, true, wantSamples);
      passes.aoMaterial.uniforms.tDepth.value = passes.beauty.depthTexture;
      passes.aoMaterial.uniforms.uFullResolution.value.set(width, height);
      passes.blurMaterial.uniforms.tDepth.value = passes.beauty.depthTexture;
      passes.compositeMaterial.uniforms.tDiffuse.value = passes.beauty.texture;
      passes.compositeMaterial.uniforms.tDepth.value = passes.beauty.depthTexture;
      for (const stage of pipelineStages()) stage.resize(width, height);
      // The half-res AO targets follow the beauty target.
      passes.ao?.dispose();
      passes.blur?.dispose();
      passes.ao = null;
      passes.blur = null;
    }
    if (ao && !passes.ao) {
      passes.ao = makeTarget(halfWidth, halfHeight, false);
      passes.blur = makeTarget(halfWidth, halfHeight, false);
      passes.aoMaterial.uniforms.uResolution.value.set(halfWidth, halfHeight);
      passes.blurMaterial.uniforms.tAO.value = passes.ao.texture;
      passes.blurMaterial.uniforms.uTexel.value.set(1 / halfWidth, 1 / halfHeight);
      passes.compositeMaterial.uniforms.tAO.value = passes.blur!.texture;
    }
    if (!ao && passes.ao) {
      passes.ao.dispose();
      passes.blur?.dispose();
      passes.ao = null;
      passes.blur = null;
    }

    const now = performance.now();
    const dt = passes.lastMs > 0 ? Math.min(0.1, (now - passes.lastMs) / 1000) : 1 / 60;
    passes.lastMs = now;

    const perspective = camera as THREE.PerspectiveCamera;
    passes.aoMaterial.uniforms.uProj.value = camera.projectionMatrix;
    passes.aoMaterial.uniforms.uInvProj.value = camera.projectionMatrixInverse;
    passes.blurMaterial.uniforms.uNear.value = perspective.near ?? 0.1;
    passes.blurMaterial.uniforms.uFar.value = perspective.far ?? 200;
    passes.compositeMaterial.uniforms.uNear.value = perspective.near ?? 0.1;
    passes.compositeMaterial.uniforms.uFar.value = perspective.far ?? 200;

    renderer.setRenderTarget(passes.beauty);
    renderer.render(scene, camera);

    if (ao && passes.ao && passes.blur) {
      renderer.setRenderTarget(passes.ao);
      renderer.render(passes.aoScene, passes.quadCamera);
      renderer.setRenderTarget(passes.blur);
      renderer.render(passes.blurScene, passes.quadCamera);
    }
    passes.compositeMaterial.uniforms.uAoOn.value = ao && passes.ao ? 1 : 0;

    // Stages: each is handed what the ones before it drew and lays itself
    // over that, so the last one that draws is what the composite lays over.
    let dustOn = 0;
    if (pipelineStageCount() > 0) {
      let under: StageOutput | null = null;
      for (const stage of pipelineStages()) {
        const ctx = { renderer, camera, scene, beauty: passes.beauty, width, height, dt, under };
        beginGpuDustStage();
        const drew = stage.render(ctx);
        endGpuDustStage();
        if (drew) {
          const output = stage.output();
          if (output) {
            under = output;
            passes.compositeMaterial.uniforms.tDust.value = output.texture;
            // A half-res layer is laid up here, in the pass the composite is anyway.
            if (output.halfSize) (passes.compositeMaterial.uniforms.uDustHalfSize.value as THREE.Vector2).copy(output.halfSize);
            dustOn = output.halfSize ? 2 : 1;
          }
        }
      }
    }
    passes.compositeMaterial.uniforms.uDustOn.value = dustOn;
    renderStats.dustPassSkipped = dustOn ? 0 : 1;

    renderer.setRenderTarget(null);
    renderer.render(passes.compositeScene, passes.quadCamera);
  }, 1);

  return null;
}
