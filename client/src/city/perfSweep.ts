// One click, the whole per-feature cost matrix, measured where it matters.
//
// A GPU-bound frame can only be diagnosed on the machine that is slow. Every
// number this project recorded before this tool came from a box whose GPU
// renders the city in ~2 ms at 4000x2300 -- a machine that cannot reveal fill
// cost at all. Generalising from it is how a change that multiplied per-pixel
// work got signed off as free, and then how a draw-call trade got flipped the
// wrong way for the machine that was actually struggling.
//
// So the sweep runs on the reporter's hardware: flip one feature, measure,
// flip it back, next. It captures GPU time from the timer query alongside the
// CPU breakdown, because those are the two a frame budget is actually made of
// and the panel could previously only show one.
//
// Trust is the design constraint, learned the hard way. The first M3 report
// contained four rows of garbage: the dpr steps ran right after a
// threshold-rebuild step, and restoring the threshold rebuilt the 41k-chunk
// mesh INSIDE their 45-frame warm-up -- GPU read HIGHER at fewer pixels, and
// the corruption was only recognisable because it was physically impossible.
// Hence three rules below:
//
//   1. Warm-up is DERIVED from what changed between steps, never hand-annotated
//      per call, so a reorder cannot silently measure a rebuild again.
//   2. Every step records the canvas backing store, so "dpr applied" is a fact
//      in the report rather than an assumption about it.
//   3. The baseline is re-measured at the end (`sentinel`); if it no longer
//      matches the start, the report flags itself unstable -- thermal
//      throttling, a died stream, a background tab -- instead of being
//      reasoned from.

import { renderStats } from './renderStats';
import { cityTextureAnisotropy, setCityTextureAnisotropy } from '../scene/cityTextures';
import {
  ambientOcclusionPreferred,
  cityTextureDetail,
  dprCapOverride,
  instanceShareThresholdSetting,
  qualityTier,
  setAmbientOcclusionEnabled,
  setCityTextureDetail,
  setDprCap,
  setInstanceShareThreshold,
  setQualityTier,
  setShadowMapSize,
  aoMsaaSamplesSetting,
  setAoMsaaSamples,
  setHeroTilingEnabled,
  heroTilingEnabled,
  setShadowsEnabled,
  setSkyDomeEnabled,
  setSkyIblEnabled,
  restoreStoredRenderSettings,
  shadowMapSizeOverride,
  shadowsEnabled,
  snapshotStoredRenderSettings,
  skyDomeEnabled,
  skyIblEnabledSetting,
  type CityTextureDetail,
  type QualityTier,
} from '../app/renderQuality';

/** Frames per step, after the warm-up. ~1 s at 120 fps, ~2 s at 60. */
const FRAMES = 120;
/** Discarded first, while shaders recompile and uniforms settle. */
const WARMUP_FRAMES = 45;
/**
 * Warm-up for steps that rebuild something big: the city mesh (threshold), the
 * whole render-target set (dpr), the shadow map, or a texture re-upload
 * (aniso). Applied automatically whenever those fields differ from the
 * previously APPLIED config -- including when a step implicitly restores them.
 */
const REBUILD_WARMUP = 240;

type Config = {
  tier: QualityTier;
  ao: boolean;
  shadows: boolean;
  cityTextures: CityTextureDetail;
  skyIbl: boolean;
  skyDome: boolean;
  dprCap: number | null;
  shareThreshold: number;
  shadowMapSize: number | null;
  albedoAniso: number;
  heroTiling: boolean;
  aoMsaa: number;
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
    shareThreshold: instanceShareThresholdSetting(),
    shadowMapSize: shadowMapSizeOverride(),
    albedoAniso: cityTextureAnisotropy(),
    heroTiling: heroTilingEnabled(),
    aoMsaa: aoMsaaSamplesSetting(),
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
  setInstanceShareThreshold(config.shareThreshold);
  setShadowMapSize(config.shadowMapSize);
  setCityTextureAnisotropy(config.albedoAniso);
  setHeroTilingEnabled(config.heroTiling);
  setAoMsaaSamples(config.aoMsaa);
}

/** Fields whose change means something big reallocates before steady state. */
function needsRebuildWarmup(previous: Config, next: Config): boolean {
  return previous.shareThreshold !== next.shareThreshold
    || previous.dprCap !== next.dprCap
    || previous.shadowMapSize !== next.shadowMapSize
    || previous.albedoAniso !== next.albedoAniso
    // Changing the sample count reallocates the whole AO target set.
    || previous.aoMsaa !== next.aoMsaa;
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

function canvasBackingStore(): string {
  const canvas = document.querySelector('canvas');
  return canvas ? `${canvas.width}x${canvas.height}` : 'unknown';
}

export interface PerfSweepStep {
  label: string;
  config: Config;
  /** rAF-to-rAF wall clock. Includes vsync idle, so it CANNOT go below the refresh period. */
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
  /**
   * Multi-draw sub-draws the city submits. The other half of the draw-call
   * trade: raising the instancing threshold cuts `drawCalls` and raises this.
   */
  subDraws: number;
  triangles: number;
  /** Canvas backing store DURING this step -- the proof a dpr step applied. */
  backingStore: string;
  /** A hidden tab throttles rAF; a step measured hidden is garbage. */
  documentHidden: boolean;
  elapsedMs: number;
}

export interface PerfSweepReport {
  capturedAt: string;
  userAgent: string;
  devicePixelRatio: number;
  backingStore: string;
  gpu: string;
  gpuTimingAvailable: boolean;
  /**
   * Whether WEBGL_multi_draw is real here. Without it, every one of the city's
   * "sub-draws" is a genuine draw call issued in a loop -- which would explain
   * a per-sub-draw cost that scales with count and not with pixels, exactly
   * the signature the M3 Metal reports show.
   */
  multiDrawSupported: boolean;
  /**
   * Baseline re-measured after everything else. If this diverges from the
   * first step the machine changed under the sweep -- throttling, a died
   * stream, a backgrounded tab -- and the whole table should be distrusted,
   * which is what `unstable` says.
   */
  sentinel: PerfSweepStep;
  unstable: boolean;
  steps: PerfSweepStep[];
}

async function measureStep(label: string, warmupFrames: number): Promise<PerfSweepStep> {
  const startedAt = performance.now();
  for (let i = 0; i < warmupFrames; i += 1) await nextFrame();
  const frames: number[] = [];
  const gpu: number[] = [];
  const cpu: number[] = [];
  let glSubmit = 0;
  let cityFrame = 0;
  let drawCalls = 0;
  let triangles = 0;
  let documentHidden = false;
  for (let i = 0; i < FRAMES; i += 1) {
    await nextFrame();
    frames.push(renderStats.frameTotalMs);
    cpu.push(renderStats.cpuFrameMs);
    if (renderStats.gpuFrameMs > 0) gpu.push(renderStats.gpuFrameMs);
    glSubmit += renderStats.glRenderMs;
    cityFrame += renderStats.cityFrameMs;
    drawCalls = renderStats.drawCalls;
    triangles = renderStats.triangles;
    if (document.hidden) documentHidden = true;
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
    subDraws: renderStats.subDraws,
    triangles,
    backingStore: canvasBackingStore(),
    documentHidden,
    elapsedMs: performance.now() - startedAt,
  };
}

function describeGpu(): { gpu: string; multiDrawSupported: boolean } {
  try {
    const canvas = document.querySelector('canvas');
    const context = canvas?.getContext('webgl2') as WebGL2RenderingContext | null;
    const info = context?.getExtension('WEBGL_debug_renderer_info');
    const gpu = info && context
      ? String(context.getParameter((info as { UNMASKED_RENDERER_WEBGL: number })
        .UNMASKED_RENDERER_WEBGL))
      : 'unknown';
    return { gpu, multiDrawSupported: context?.getExtension('WEBGL_multi_draw') != null };
  } catch {
    // A browser that refuses the debug extension should not take the sweep down.
    return { gpu: 'unknown', multiDrawSupported: false };
  }
}

/**
 * Measure the current settings, each candidate change one at a time, a floor,
 * and finally the baseline again. Restores what it found.
 *
 * One change at a time rather than cumulatively: the question is what each
 * costs, and stacking them hides which one mattered. Mesh-rebuilding steps run
 * LAST so nothing measured after them can inherit a rebuild.
 */
export async function runPerfSweep(): Promise<PerfSweepReport> {
  const original = currentConfig();
  // The setters persist, and a sweep must not: without this, running a sweep
  // froze the then-current defaults into localStorage and no future default
  // ever reached that browser again. Raw entries, restored verbatim --
  // including absent keys staying absent.
  const storedBefore = snapshotStoredRenderSettings();
  const steps: PerfSweepStep[] = [];
  let applied = original;
  const step = async (label: string, patch: Partial<Config>): Promise<PerfSweepStep> => {
    const next: Config = { ...original, ...patch };
    const warmup = needsRebuildWarmup(applied, next) ? REBUILD_WARMUP : WARMUP_FRAMES;
    applyConfig(next);
    applied = next;
    const measured = await measureStep(label, warmup);
    steps.push(measured);
    return measured;
  };

  let sentinel: PerfSweepStep;
  try {
    await step('as configured', {});
    await step('AO off', { ao: false });
    await step('shadows off', { shadows: false });
    await step('shadow map 1024', { shadowMapSize: 1024 });
    await step('sky IBL off', { skyIbl: false });
    await step('sky dome off', { skyDome: false });
    await step('anti-tiling stack off', { heroTiling: false });
    await step('AO msaa off (no AA)', { aoMsaa: 0 });
    await step('city textures: albedo only', { cityTextures: 'albedo' });
    await step('city textures: off', { cityTextures: 'off' });
    await step('albedo aniso 1', { albedoAniso: 1 });
    await step('dpr cap 1.5', { dprCap: 1.5 });
    await step('dpr cap 1.0', { dprCap: 1 });
    await step('everything off (floor)', {
      ao: false,
      shadows: false,
      skyIbl: false,
      skyDome: false,
      cityTextures: 'off',
    });
    // Mesh rebuilds, dead last: nothing after them but the sentinel, which is
    // itself a rebuild back to the original threshold.
    await step('instance threshold 4', { shareThreshold: 4 });
    await step('instance threshold 32', { shareThreshold: 32 });
    sentinel = await step('as configured (sentinel)', {});
    steps.pop();
  } finally {
    applyConfig(original);
    restoreStoredRenderSettings(storedBefore);
  }

  const first = steps[0];
  // Drift needs BOTH a relative and an absolute bar. On a machine with huge
  // headroom the medians are ~2 ms and wobble +/-20% as pure noise; a
  // relative-only test flagged such a run unstable, which teaches people to
  // ignore the flag -- worse than not having one. A machine actually
  // throttling moves by milliseconds, not tenths.
  const drift = Math.abs(sentinel.gpuMs.median - first.gpuMs.median);
  const anyHidden = sentinel.documentHidden || steps.some((s) => s.documentHidden);
  const unstable = anyHidden
    || (sentinel.gpuMs.median > 0 && first.gpuMs.median > 0
      && drift / first.gpuMs.median > 0.2 && drift > 1);

  const { gpu, multiDrawSupported } = describeGpu();
  return {
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    backingStore: canvasBackingStore(),
    gpu,
    gpuTimingAvailable: steps.some((s) => s.gpuMs.median > 0),
    multiDrawSupported,
    sentinel,
    unstable,
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
    `multi-draw: ${report.multiDrawSupported
      ? 'native'
      : 'EMULATED — every sub-draw is a real draw call; low instance thresholds win here'}`,
    `120 fps budget: ${budget.toFixed(2)} ms`,
  ];
  if (report.unstable) {
    lines.push(
      '',
      '!! UNSTABLE: the end-of-run baseline no longer matches the start (or a',
      '!! step ran in a hidden tab). The machine changed under the sweep --',
      '!! thermal throttle, a died stream, a background tab. Re-run before',
      '!! reasoning from any row.',
    );
  }
  lines.push(
    '',
    'NOTE: frame ms is rAF-to-rAF and is clamped by vsync, so it can never read',
    'below the refresh period however much headroom there is. gpu ms is not',
    'clamped — that is the column that says whether 120 is reachable.',
    '',
    'step                            frame med  frame p95   gpu med   gpu p95   cpu med  draws  subdraws  backing',
  );
  const rows = [...report.steps, report.sentinel];
  for (const step of rows) {
    lines.push(
      `${step.label.padEnd(30)} ${step.frameMs.median.toFixed(2).padStart(8)}  `
      + `${step.frameMs.p95.toFixed(2).padStart(9)}  `
      + `${step.gpuMs.median.toFixed(2).padStart(8)}  `
      + `${step.gpuMs.p95.toFixed(2).padStart(8)}  `
      + `${step.cpuMs.median.toFixed(2).padStart(8)}  ${String(step.drawCalls).padStart(5)}`
      + `  ${String(step.subDraws).padStart(8)}`
      + `  ${step.backingStore}${step.documentHidden ? '  HIDDEN' : ''}`,
    );
  }
  return lines.join('\n');
}
