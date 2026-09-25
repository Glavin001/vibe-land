// The canvas and the governor every city page shares.
//
// GameScene and /cityreplay both mount a Canvas with these props and this
// component inside it. The bench page exists to measure what the game draws;
// that is only true while neither can drift from the other, so the context
// flags, the pixel budget, the dynamic resolution and the dust trims are
// decided here and nowhere else.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { renderStats } from '../city/renderStats';
import { cityTapeRecorder } from '../city/cityTape';
import { hotspotWatch } from '../city/hotspotWatch';
import {
  antialiasEnabled,
  dynamicResolutionEnabled,
  flatToneMapping,
  governorDustSprites,
  governorFluidCap,
  governorMsaaCap,
  governorPaused,
  governorSampleScale,
  maxDpr,
  onRenderQualityChange,
  setGovernorDustSprites,
  setGovernorFluidCap,
  setGovernorMsaaCap,
  setGovernorSampleScale,
} from '../app/renderQuality';
import { frameRateCapFps, useFrameRateCap } from './frameRateCap';
import { framePipelineMounted, setFramePipelineResolutionScale } from '../graphics/framePipelineStages';
import { canvasDprChanges, resolutionPlan } from './dynamicResolution';

/**
 * Canvas props from the quality tier. dpr is the multiplier on every fill
 * cost in the scene: R3F's default of 2 on a 3x phone renders ~2.3 MP.
 * antialias and flat (tonemapping) are context-creation-time -- read once
 * here, a tier change applies them on the next reload; RenderGovernor
 * handles dpr live.
 */
export function sceneCanvasProps() {
  return {
    shadows: true,
    // `?maxFps=N` only (off by default): the cap's own loop advances R3F.
    frameloop: (frameRateCapFps() === null ? 'always' : 'never') as 'always' | 'never',
    dpr: [1, maxDpr()] as [number, number],
    flat: flatToneMapping(),
    gl: { antialias: antialiasEnabled(), powerPreference: 'high-performance' as const },
    camera: { fov: 75, near: 0.1, far: 200, position: [0, 5, 10] as [number, number, number] },
  };
}

/**
 * Applies dpr changes from the quality tier to the live renderer, and runs
 * the GPU governor. Mounted inside the Canvas of every page that draws the
 * city -- the game and /cityreplay -- because setDpr comes from the R3F
 * store, and because one governor is the only way two pages stay the same.
 * Unlike antialias/tonemapping, pixel ratio is a plain resize: flipping the
 * tier mid-game moves the fps immediately, which is the whole point of the
 * toggle as a measurement instrument.
 */
export function RenderGovernor(): null {
  useFrameRateCap();
  const fpsCap = useMemo(() => frameRateCapFps(), []);
  const setDpr = useThree((state) => state.setDpr);
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const scaleRef = useRef(1);
  // Whether the last apply() scaled the frame pipeline (true) or the canvas.
  const pipelineScaledRef = useRef<boolean | null>(null);
  const gov = useRef({
    frameEma: 0,
    cpuEma: 0,
    gpuEma: 0,
    dustEma: 0,
    pacingMin: Infinity,
    pacingFrames: 0,
    period: 0,
    sinceAdjust: 0,
    // The recovery probe: how long to hold before trying a rung back, and
    // the rung on trial. A trial that overruns is undone and the hold doubles.
    probeHoldFrames: 180,
    heldFrames: 0,
    trial: null as null | { undo: () => void; framesLeft: number },
    frameIndex: 0,
  });
  // Dynamic resolution (dynamicResolution.ts). With the frame pipeline
  // mounted the canvas keeps the tier's pixel ratio and the pipeline renders
  // at `scale` of it, so a trim resizes offscreen targets only; resizing the
  // canvas reallocated the drawing buffer synchronously, 25-100 ms of main
  // thread per step when the GPU was shared with the city server. Without a
  // pipeline the canvas itself is scaled, as before. The canvas is resized
  // only when its pixel ratio actually changes (a tier or cap change, or the
  // pipeline coming or going).
  const apply = (scale: number) => {
    scaleRef.current = scale;
    renderStats.dprScale = scale;
    const inPipeline = framePipelineMounted();
    pipelineScaledRef.current = inPipeline;
    const plan = resolutionPlan(scale, Math.min(window.devicePixelRatio, maxDpr()), inPipeline);
    setFramePipelineResolutionScale(plan.pipelineScale);
    if (canvasDprChanges(gl.getPixelRatio(), plan.canvasDpr)) setDpr(plan.canvasDpr);
  };
  useEffect(
    () =>
      onRenderQualityChange(() => {
        if (!dynamicResolutionEnabled()) scaleRef.current = 1;
        apply(scaleRef.current);
      }),
    [setDpr],
  );
  // The GPU governor.
  //
  // Over budget is decided from the WALL CLOCK: the frame's own pacing is
  // longer than the display period, and the CPU is spending a large share of
  // that waiting (offFrame), which is what GPU-bound looks like. The per-pass
  // GPU timers are NOT used for that decision: on the reporter's M3 they
  // summed to 26-52 ms inside 12 ms frames, so ANGLE's Metal queries report
  // something wider than the pass. They are still the only thing that says
  // WHICH pass is heavy, and that is all they decide here: whether a trim
  // comes out of the dust stage (samples to half, fluid balanced -> fast ->
  // off, samples to a quarter) or out of pixels (dpr, 8% a step, floor 0.6).
  //
  // Recovery cannot read headroom off a vsync-locked frame, so it probes:
  // after a hold, one rung is given back on trial; if the frame overruns
  // within a second the rung is taken away again and the hold doubles (to a
  // cap of half a minute); if it holds, the trial sticks and the hold resets.
  useFrame(() => {
    const g = gov.current;
    // The pipeline came or went under a trimmed scale: move the scale to
    // whichever now does the scaling.
    if (pipelineScaledRef.current !== null && pipelineScaledRef.current !== framePipelineMounted()) {
      apply(scaleRef.current);
    }
    if (cityTapeRecorder.recording) {
      cityTapeRecorder.noteFrame(renderStats.frameTotalMs, renderStats.cpuFrameMs, camera);
    }
    hotspotWatch.observe(performance.now(), renderStats.frameTotalMs);
    if (!dynamicResolutionEnabled() || governorPaused()) {
      gl.shadowMap.autoUpdate = true;
      if (scaleRef.current !== 1) apply(1);
      if (governorFluidCap() !== 'balanced') setGovernorFluidCap('balanced');
      if (governorSampleScale() !== 1) setGovernorSampleScale(1);
      if (governorDustSprites()) setGovernorDustSprites(false);
      if (governorMsaaCap() !== Infinity) setGovernorMsaaCap(Infinity);
      renderStats.gpuBudgetMs = 0;
      return;
    }
    const frame = renderStats.frameTotalMs;
    const cpu = renderStats.cpuFrameMs;
    if (frame > 0) {
      g.frameEma = g.frameEma > 0 ? g.frameEma * 0.9 + frame * 0.1 : frame;
      g.cpuEma = g.cpuEma > 0 ? g.cpuEma * 0.9 + cpu * 0.1 : cpu;
      if (frame < g.pacingMin) g.pacingMin = frame;
      g.pacingFrames += 1;
    }
    const gpu = renderStats.gpuFrameMs;
    if (gpu > 0) g.gpuEma = g.gpuEma > 0 ? g.gpuEma * 0.9 + gpu * 0.1 : gpu;
    g.dustEma = g.dustEma > 0 ? g.dustEma * 0.9 + renderStats.gpuDustMs * 0.1 : renderStats.gpuDustMs;
    if (g.pacingFrames >= 120) {
      // Quantise to the refresh rates that exist, and keep the FASTEST period
      // ever seen: a window whose shortest frame is 12 ms is a loaded 120 Hz
      // display, not a 60 Hz one, and relaxing the budget on it mid-storm is
      // exactly backwards. Until anything fast has been seen, assume 60.
      let seen = 0;
      if (g.pacingMin < 9.5) seen = 8.33;
      else if (g.pacingMin < 17.5) seen = 16.67;
      if (seen > 0 && (g.period === 0 || seen < g.period)) g.period = seen;
      else if (g.period === 0) g.period = 16.67;
      g.pacingMin = Infinity;
      g.pacingFrames = 0;
    }
    // A frame-rate cap (`?maxFps`) paces frames on purpose: its interval is the
    // budget, or the governor would read the cap as GPU overload and trim pixels.
    const period = Math.max(g.period || 8.33, fpsCap === null ? 0 : 1000 / fpsCap);
    renderStats.gpuBudgetMs = period;
    hotspotWatch.setPeriod(period);
    // Shadows at 60 Hz on a 120 Hz display. The shadow pass re-renders every
    // vertex of the city into a 2048^2 map; refreshing it every other frame
    // halves that for a lag no eye can see at these rates, and it costs a
    // frame of shadow lag only on debris in flight. Every frame on 60 Hz.
    g.frameIndex += 1;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = period > 9 || (g.frameIndex & 1) === 0;
    const gpuBound = g.frameEma - g.cpuEma > g.frameEma * 0.4;
    const overBudget = g.frameEma > period * 1.15 && gpuBound;
    const dustHeavy = g.gpuEma > 0 && g.dustEma > g.gpuEma * 0.35;

    // A rung on trial: undo it the moment the frame overruns, else let it stick.
    if (g.trial) {
      g.trial.framesLeft -= 1;
      if (overBudget) {
        g.trial.undo();
        g.trial = null;
        g.probeHoldFrames = Math.min(1800, g.probeHoldFrames * 2);
        g.heldFrames = 0;
        return;
      }
      if (g.trial.framesLeft <= 0) {
        g.trial = null;
        g.probeHoldFrames = 180;
        g.heldFrames = 0;
      }
      return;
    }

    g.sinceAdjust += 1;
    if (g.sinceAdjust < 20 || g.frameEma <= 0) return;
    g.sinceAdjust = 0;

    if (overBudget) {
      g.heldFrames = 0;
      const scale = governorSampleScale();
      const cap = governorFluidCap();
      if (dustHeavy && scale > 0.5) setGovernorSampleScale(0.5);
      else if (dustHeavy && cap === 'balanced') setGovernorFluidCap('fast');
      else if (dustHeavy && cap === 'fast') setGovernorFluidCap('off');
      else if (dustHeavy && scale > 0.25) setGovernorSampleScale(0.25);
      else if (dustHeavy && !governorDustSprites()) setGovernorDustSprites(true);
      // Multisampling goes before pixels: a fifth of the GPU frame on the
      // bench, and the least visible thing on a dpr-2 display.
      else if (governorMsaaCap() > 0) setGovernorMsaaCap(0);
      else if (scaleRef.current > 0.6) apply(Math.max(0.6, scaleRef.current * 0.92));
      return;
    }

    // Under budget (or CPU-bound, where pixels are free): probe a rung back.
    g.heldFrames += 20;
    if (g.heldFrames < g.probeHoldFrames) return;
    g.heldFrames = 0;
    const scale = governorSampleScale();
    const cap = governorFluidCap();
    const before = scaleRef.current;
    if (before < 1) {
      apply(Math.min(1, before * 1.08));
      g.trial = { undo: () => apply(before), framesLeft: 60 };
    } else if (governorMsaaCap() !== Infinity) {
      setGovernorMsaaCap(Infinity);
      g.trial = { undo: () => setGovernorMsaaCap(0), framesLeft: 60 };
    } else if (governorDustSprites()) {
      setGovernorDustSprites(false);
      g.trial = { undo: () => setGovernorDustSprites(true), framesLeft: 60 };
    } else if (scale < 0.5) {
      setGovernorSampleScale(0.5);
      g.trial = { undo: () => setGovernorSampleScale(0.25), framesLeft: 60 };
    } else if (cap === 'off') {
      setGovernorFluidCap('fast');
      g.trial = { undo: () => setGovernorFluidCap('off'), framesLeft: 60 };
    } else if (cap === 'fast') {
      setGovernorFluidCap('balanced');
      g.trial = { undo: () => setGovernorFluidCap('fast'), framesLeft: 60 };
    } else if (scale < 1) {
      setGovernorSampleScale(1);
      g.trial = { undo: () => setGovernorSampleScale(0.5), framesLeft: 60 };
    }
  });
  return null;
}
