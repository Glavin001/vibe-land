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
/**
 * Frames per step on a phone.
 *
 * Fewer, because a frame there can be 50 ms: 120 of them is six seconds per
 * step, and iOS will throttle or evict a tab held busy that long. 60 frames
 * still gives a median over ~2 s of rendering.
 */
const MOBILE_FRAMES = 60;
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

/**
 * The shortest frame this page is actually being GIVEN, in ms.
 *
 * Not the panel's refresh rate and not `screen`: what matters is the rate at
 * which THIS document is presented, which is lower than the display whenever
 * something else is competing. Two tabs of this game open on a 120 Hz MacBook
 * present at 60 each -- the GPU cost is unchanged and every frame median
 * doubles, which reads exactly like a renderer that got twice as slow. That
 * misreading has now been made three times in this project's history, twice by
 * the assistant writing this, so the sweep measures it instead of assuming it.
 *
 * The minimum over the sample, not the median: a dropped frame lengthens a
 * period but nothing shortens one below the true cadence.
 */
async function measurePresentPeriod(samples = 40): Promise<number> {
  let previous = await new Promise<number>((r) => requestAnimationFrame(r));
  let shortest = Infinity;
  for (let i = 0; i < samples; i += 1) {
    const now = await new Promise<number>((r) => requestAnimationFrame(r));
    const delta = now - previous;
    previous = now;
    if (delta > 0.5) shortest = Math.min(shortest, delta);
  }
  return Number.isFinite(shortest) ? shortest : 0;
}

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
  /** Which step set ran. `mobile` is short and phone-ordered. */
  profile?: PerfSweepProfile;
  /** Shortest frame this document was given, before the sweep touched anything. */
  presentPeriodMs?: number;
  /** Frame times are set by presentation cadence, not by our work. */
  framePaced?: boolean;
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

async function measureStep(
  label: string,
  warmupFrames: number,
  sampleFrames: number = FRAMES,
): Promise<PerfSweepStep> {
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
  for (let i = 0; i < sampleFrames; i += 1) {
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
    glSubmitMs: glSubmit / sampleFrames,
    cityFrameMs: cityFrame / sampleFrames,
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
/**
 * `full` prices every feature; `mobile` prices the few that could plausibly
 * account for a 50 ms frame on a phone, in descending order of suspicion, and
 * gets through them before iOS throttles a busy tab.
 */
export type PerfSweepProfile = 'full' | 'mobile';

export async function runPerfSweep(
  profile: PerfSweepProfile = 'full',
): Promise<PerfSweepReport> {
  const mobile = profile === 'mobile';
  const sampleFrames = mobile ? MOBILE_FRAMES : FRAMES;
  const original = currentConfig();
  // Before anything is touched, and with the scene rendering as the user left
  // it -- the number this qualifies is every frame median below.
  const presentPeriodMs = await measurePresentPeriod();
  // The setters persist, and a sweep must not: without this, running a sweep
  // froze the then-current defaults into localStorage and no future default
  // ever reached that browser again. Raw entries, restored verbatim --
  // including absent keys staying absent.
  const storedBefore = snapshotStoredRenderSettings();
  const steps: PerfSweepStep[] = [];
  let applied = original;
  const step = async (label: string, patch: Partial<Config>): Promise<PerfSweepStep> => {
    const next: Config = { ...original, ...patch };
    let warmup = needsRebuildWarmup(applied, next) ? REBUILD_WARMUP : WARMUP_FRAMES;
    // Warm-up is counted in FRAMES, and a phone's frames are ~15x longer than
    // the 120 fps machine these counts were chosen on -- 240 of them is nearly
    // a minute. Scaled down, but never below what a shader recompile needs.
    if (mobile) warmup = Math.max(20, Math.round(warmup / 4));
    applyConfig(next);
    applied = next;
    const measured = await measureStep(label, warmup, sampleFrames);
    steps.push(measured);
    return measured;
  };

  let sentinel: PerfSweepStep;
  try {
    await step('as configured', {});
    if (mobile) {
      // Ordered by suspicion for a fill-and-geometry-bound phone. Shadows
      // first: a second full pass over 41k chunks is the largest single thing
      // the FAST tier still does. Then pixels, then the two shading costs,
      // then a floor that says how much of the frame is fixed cost no setting
      // can reach.
      await step('shadows off', { shadows: false });
      await step('dpr cap 1.0', { dprCap: 1 });
      await step('dpr cap 0.75', { dprCap: 0.75 });
      await step('city textures: off', { cityTextures: 'off' });
      await step('anti-tiling stack off', { heroTiling: false });
      await step('shadows off + dpr 1.0', { shadows: false, dprCap: 1 });
      await step('everything off (floor)', {
        ao: false,
        shadows: false,
        skyIbl: false,
        skyDome: false,
        cityTextures: 'off',
        dprCap: 1,
      });
      sentinel = await step('as configured (sentinel)', {});
      steps.pop();
      return finishReport(steps, sentinel, profile, presentPeriodMs);
    }
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

  return finishReport(steps, sentinel, profile, presentPeriodMs);
}

function finishReport(
  steps: PerfSweepStep[],
  sentinel: PerfSweepStep,
  profile: PerfSweepProfile,
  presentPeriodMs: number,
): PerfSweepReport {
  const first = steps[0];
  // Drift needs BOTH a relative and an absolute bar. On a machine with huge
  // headroom the medians are ~2 ms and wobble +/-20% as pure noise; a
  // relative-only test flagged such a run unstable, which teaches people to
  // ignore the flag -- worse than not having one. A machine actually
  // throttling moves by milliseconds, not tenths.
  // Prefer GPU time; fall back to wall-clock frame time where the timer query
  // does not exist at all -- which is every iOS browser and every Safari, i.e.
  // exactly the machines this flag matters most on, since a phone throttles
  // under load and a desktop mostly does not. Frame time is the noisier
  // signal, hence the wider relative bar.
  const useGpu = sentinel.gpuMs.median > 0 && first.gpuMs.median > 0;
  const before = useGpu ? first.gpuMs.median : first.frameMs.median;
  const after = useGpu ? sentinel.gpuMs.median : sentinel.frameMs.median;
  const spread = useGpu
    ? first.gpuMs.p95 - first.gpuMs.median
    : first.frameMs.p95 - first.frameMs.median;
  const drift = Math.abs(after - before);
  // The absolute bar is derived from the run's OWN jitter rather than fixed.
  // It was 1 ms, picked when a fast box's medians were ~2 ms and its p95 sat
  // half a millisecond above them; measure the same box a touch warmer and
  // ordinary noise clears a fixed millisecond, which is how a constant chosen
  // to stop false positives started producing them. Drift has to beat the
  // spread the sweep already saw within a single step to mean anything.
  const bar = Math.max(1, spread * 2);
  const anyHidden = sentinel.documentHidden || steps.some((s) => s.documentHidden);
  const unstable = anyHidden
    || (before > 0 && drift / before > (useGpu ? 0.2 : 0.3) && drift > bar);

  const { gpu, multiDrawSupported } = describeGpu();
  return {
    profile,
    presentPeriodMs,
    /**
     * True when the frame column is pinned to the presentation cadence rather
     * than to our work: the floor step -- everything off, the cheapest frame
     * this renderer can produce -- still takes more than 1.5 present periods.
     * At that point no row's frame time is telling you what a feature costs.
     */
    framePaced: presentPeriodMs > 0
      && steps[steps.length - 1].frameMs.median > presentPeriodMs * 1.5,
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
    `presented at: ${report.presentPeriodMs
      ? `${report.presentPeriodMs.toFixed(2)} ms (${(1000 / report.presentPeriodMs).toFixed(0)} fps)`
      : 'not measured'}`,
  ];
  if (report.framePaced) {
    lines.push(
      '',
      '!! FRAME-PACED: with everything turned off this page still could not',
      '!! present faster than the cadence above, so the frame columns measure',
      '!! how often the browser presents this document -- NOT what any feature',
      '!! costs. The usual cause is something else rendering: a second tab of',
      '!! this game halves a 120 Hz MacBook to 60 with the GPU cost unchanged.',
      '!! Close the others and re-run, or read the gpu column, which is not',
      '!! paced and is the one that says whether 120 is reachable.',
    );
  }
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

/**
 * The phone-readable summary: what each thing costs, in fps and ms, sorted by
 * saving.
 *
 * A phone cannot download a report anywhere useful and cannot show a 110-column
 * table, so this is built to be SCREENSHOTTED: one line per lever, deltas
 * against the baseline rather than absolutes to compare by eye, and fps
 * alongside ms because fps is the number the user actually feels.
 *
 * The vsync caveat is load-bearing here. `frameMs` is rAF-to-rAF, so it cannot
 * read below the refresh period -- once a step gets fast enough to hit the
 * panel's cap, its true cost is hidden and every further saving reads as zero.
 * Rows that are pinned to the refresh floor say so instead of claiming a
 * suspiciously round win.
 */
export function formatPerfSweepMobile(report: PerfSweepReport): string[] {
  const rows = [...report.steps, report.sentinel];
  const base = report.steps[0];
  const fps = (ms: number) => (ms > 0 ? 1000 / ms : 0);
  // The fastest frame anything measured -- a lower bound on this display's
  // refresh period. A step within 10% of it may be vsync-limited, not free.
  const floor = Math.min(...rows.map((r) => r.frameMs.median));
  const lines = [
    `${report.gpu.slice(0, 34)}`,
    `${report.backingStore} @ dpr ${report.devicePixelRatio}`
    + `${report.gpuTimingAvailable ? '' : ' | no gpu timer'}`,
    `baseline ${base.frameMs.median.toFixed(1)}ms = ${fps(base.frameMs.median).toFixed(0)}fps`
    + ` | ${base.drawCalls} draws`,
  ];
  if (report.unstable) lines.push('!! UNSTABLE - rerun, machine drifted');
  if (report.framePaced) {
    lines.push(
      '!! FRAME-PACED: even with everything off,',
      '!! this page is only presented every'
      + ` ${(report.presentPeriodMs ?? 0).toFixed(1)}ms.`,
      '!! Close other tabs/windows and re-run.',
    );
  }
  lines.push('');
  const scored = report.steps.slice(1)
    .map((step) => ({ step, saved: base.frameMs.median - step.frameMs.median }))
    .sort((a, b) => b.saved - a.saved);
  for (const { step, saved } of scored) {
    const pinned = step.frameMs.median <= floor * 1.1 && saved > 0;
    lines.push(
      `${step.label.slice(0, 22).padEnd(23)}`
      + `${saved >= 0 ? '-' : '+'}${Math.abs(saved).toFixed(1).padStart(5)}ms`
      + ` ${fps(step.frameMs.median).toFixed(0).padStart(3)}fps${pinned ? ' *' : ''}`,
    );
  }
  if (scored.some(({ step, saved }) => step.frameMs.median <= floor * 1.1 && saved > 0)) {
    // Deliberately hedged: the floor is whatever the fastest step measured,
    // which on a phone IS the refresh period but on a vsync-disabled test box
    // is just the cheapest configuration. Claiming "vsync" in both cases would
    // be wrong in one of them.
    lines.push('', '* at the measured floor - true saving may be larger');
  }
  return lines;
}
