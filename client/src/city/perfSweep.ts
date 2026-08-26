// One click, the whole per-feature cost matrix, measured where it matters.
//
// A GPU-bound frame can only be diagnosed on the machine that is slow. Every
// number this project has recorded came from a box whose GPU renders the city
// in ~2 ms at 4000x2300 -- six times the pixels for the same cost, which is a
// machine that cannot reveal fill cost at all. Generalising from it is how a
// change that multiplied per-pixel work got signed off as free.
//
// So the sweep runs on the reporter's hardware: flip one feature, measure,
// flip it back, next. It captures GPU time from the timer query alongside the
// CPU breakdown, because those are the two that a frame budget is actually
// made of and the panel could previously only show one.
//
// Deliberately sequential and deliberately slow (~20 s): each step discards a
// warm-up window, because changing the texture detail recompiles the city
// material and changing DPR reallocates every render target, and measuring
// that instead of the steady state is the classic way to produce a table of
// nonsense.

import { renderStats } from './renderStats';
import {
  ambientOcclusionPreferred,
  cityTextureDetail,
  dprCapOverride,
  maxDpr,
  qualityTier,
  setAmbientOcclusionEnabled,
  setCityTextureDetail,
  setDprCap,
  setQualityTier,
  setShadowsEnabled,
  setSkyDomeEnabled,
  setSkyIblEnabled,
  shadowsEnabled,
  skyDomeEnabled,
  skyIblEnabledSetting,
  type CityTextureDetail,
  type QualityTier,
} from '../app/renderQuality';

/** Frames per step, after the warm-up. ~1 s at 120 fps, ~2 s at 60. */
const FRAMES = 120;
/** Discarded first, while shaders recompile and targets reallocate. */
const WARMUP_FRAMES = 45;

type Config = {
  tier: QualityTier;
  ao: boolean;
  shadows: boolean;
  cityTextures: CityTextureDetail;
  skyIbl: boolean;
  skyDome: boolean;
  dprCap: number | null;
};

function currentConfig(): Config {
  return {
    tier: qualityTier(),
    ao: ambientOcclusionPreferred(),
    shadows: shadowsEnabled(),
    cityTextures: cityTextureDetail(),
    skyIbl: skyIblEnabledSetting(),
    skyDome: skyDomeEnabled(),
    dprCap: dprCapOverride(),
  };
}

function applyConfig(config: Config): void {
  setQualityTier(config.tier);
  setAmbientOcclusionEnabled(config.ao);
  setShadowsEnabled(config.shadows);
  setCityTextureDetail(config.cityTextures);
  setSkyIblEnabled(config.skyIbl);
  setSkyDomeEnabled(config.skyDome);
  setDprCap(config.dprCap);
}

const nextFrame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
});

function stats(values: number[]): { median: number; p95: number; max: number } {
  if (values.length === 0) return { median: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

export interface PerfSweepStep {
  label: string;
  config: Config;
  /** rAF-to-rAF wall clock. Includes vsync idle, so it CANNOT exceed the refresh period. */
  frameMs: ReturnType<typeof stats>;
  /**
   * Real GPU execution, from EXT_disjoint_timer_query_webgl2. Zero where the
   * extension is unavailable. This is the one number vsync does not clamp, so
   * it is the one that says whether there is headroom.
   */
  gpuMs: ReturnType<typeof stats>;
  cpuMs: ReturnType<typeof stats>;
  glSubmitMs: number;
  cityFrameMs: number;
  drawCalls: number;
  triangles: number;
}

export interface PerfSweepReport {
  capturedAt: string;
  userAgent: string;
  devicePixelRatio: number;
  backingStore: string;
  gpu: string;
  gpuTimingAvailable: boolean;
  refreshHintHz: number;
  steps: PerfSweepStep[];
}

async function measureStep(label: string): Promise<PerfSweepStep> {
  for (let i = 0; i < WARMUP_FRAMES; i += 1) await nextFrame();
  const frames: number[] = [];
  const gpu: number[] = [];
  const cpu: number[] = [];
  let glSubmit = 0;
  let cityFrame = 0;
  let drawCalls = 0;
  let triangles = 0;
  for (let i = 0; i < FRAMES; i += 1) {
    await nextFrame();
    frames.push(renderStats.frameTotalMs);
    cpu.push(renderStats.cpuFrameMs);
    if (renderStats.gpuFrameMs > 0) gpu.push(renderStats.gpuFrameMs);
    glSubmit += renderStats.glRenderMs;
    cityFrame += renderStats.cityFrameMs;
    drawCalls = renderStats.drawCalls;
    triangles = renderStats.triangles;
  }
  return {
    label,
    config: currentConfig(),
    frameMs: stats(frames),
    gpuMs: stats(gpu),
    cpuMs: stats(cpu),
    glSubmitMs: glSubmit / FRAMES,
    cityFrameMs: cityFrame / FRAMES,
    drawCalls,
    triangles,
  };
}

function describeGpu(): { gpu: string; backingStore: string } {
  const canvas = document.querySelector('canvas');
  const backingStore = canvas ? `${canvas.width}x${canvas.height}` : 'unknown';
  try {
    const context = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
    const info = context?.getExtension('WEBGL_debug_renderer_info');
    const gpu = info && context
      ? String(context.getParameter((info as { UNMASKED_RENDERER_WEBGL: number })
        .UNMASKED_RENDERER_WEBGL))
      : 'unknown';
    return { gpu, backingStore };
  } catch {
    // getContext on a canvas already owning a context returns it, but a browser
    // that refuses the debug extension should not take the whole sweep down.
    return { gpu: 'unknown', backingStore };
  }
}

/**
 * Measure the current settings, then each expensive feature removed one at a
 * time, then a floor with all of them off. Restores what it found.
 *
 * One feature at a time rather than cumulatively: the question is what each
 * costs, and stacking them hides which one mattered.
 */
export async function runPerfSweep(): Promise<PerfSweepReport> {
  const original = currentConfig();
  const steps: PerfSweepStep[] = [];
  const step = async (label: string, patch: Partial<Config>) => {
    applyConfig({ ...original, ...patch });
    steps.push(await measureStep(label));
  };

  try {
    await step('as configured', {});
    await step('AO off', { ao: false });
    await step('shadows off', { shadows: false });
    await step('sky IBL off', { skyIbl: false });
    await step('sky dome off', { skyDome: false });
    await step('city textures: albedo only', { cityTextures: 'albedo' });
    await step('city textures: off', { cityTextures: 'off' });
    await step('dpr cap 1.5', { dprCap: 1.5 });
    await step('dpr cap 1.0', { dprCap: 1 });
    await step('everything off (floor)', {
      ao: false,
      shadows: false,
      skyIbl: false,
      skyDome: false,
      cityTextures: 'off',
    });
  } finally {
    applyConfig(original);
  }

  const { gpu, backingStore } = describeGpu();
  return {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    backingStore,
    gpu,
    gpuTimingAvailable: steps.some((s) => s.gpuMs.median > 0),
    // What the tier would allow, for reading the dpr rows against.
    refreshHintHz: Math.round(1000 / Math.max(0.001, steps[0]?.frameMs.median ?? 0)),
    steps,
  };
}

/** Format the sweep as the table a human reads, ahead of the raw JSON. */
export function formatPerfSweep(report: PerfSweepReport): string {
  const budget = 1000 / 120;
  const lines = [
    `# city render cost — ${report.capturedAt}`,
    `gpu: ${report.gpu}`,
    `backing store: ${report.backingStore} (dpr ${report.devicePixelRatio})`,
    `gpu timing: ${report.gpuTimingAvailable ? 'available' : 'UNAVAILABLE — gpu columns are 0'}`,
    `120 fps budget: ${budget.toFixed(2)} ms`,
    '',
    'NOTE: frame ms is rAF-to-rAF and is clamped by vsync, so it can never read',
    'below the refresh period however much headroom there is. gpu ms is not',
    'clamped — that is the column that says whether 120 is reachable.',
    '',
    'step                            frame med  frame p95   gpu med   gpu p95   cpu med  draws',
  ];
  for (const step of report.steps) {
    lines.push(
      `${step.label.padEnd(30)} ${step.frameMs.median.toFixed(2).padStart(8)}  `
      + `${step.frameMs.p95.toFixed(2).padStart(9)}  `
      + `${step.gpuMs.median.toFixed(2).padStart(8)}  `
      + `${step.gpuMs.p95.toFixed(2).padStart(8)}  `
      + `${step.cpuMs.median.toFixed(2).padStart(8)}  ${String(step.drawCalls).padStart(5)}`,
    );
  }
  return lines.join('\n');
}
