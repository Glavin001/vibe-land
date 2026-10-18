/**
 * What each rendering feature actually costs, with the vsync clamp removed.
 *
 * Every frame number this project has recorded came from a vsync-locked
 * browser, where a 14 ms frame and a 4 ms frame both read 60 fps and the
 * difference hides in "off-frame". That is fine for spotting a regression past
 * the budget and useless for answering "what do we cut to reach 120?", which
 * needs the real cost of each feature and how much headroom is left.
 *
 * So: `--disable-gpu-vsync --disable-frame-rate-limit`, one session, camera
 * parked, and the features toggled through the debug panel's own buttons
 * between measurements. One session and one camera because the alternative --
 * a reload per configuration -- re-rolls the spawn point, and at this fog
 * density the difference between facing a wall and facing down a street is
 * larger than anything being measured.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-render-cost
 */
import { test } from '@playwright/test';

import {
  aimAt,
  allStructureTargets,
  cityBounds,
  cityStats,
  fireAt,
  openCity,
  parkOutside,
  resetCity,
  waitForCityRendered,
  waitUntilStill,
  walkToward,
} from '../helpers/city';
import { snapshot } from '../helpers/toolkit';
import { GPU_ARGS } from '../helpers/gpuArgs';

const ENABLED = process.env.E2E_CITY === '1';
/** Frames per measurement. 240 is ~2 s uncapped, past any warm-up transient. */
const FRAMES = 240;

/**
 * Resolution matters more than anything else being measured here, so it is a
 * parameter rather than a constant. The city is fill-bound: a 2000 px window at
 * `maxDpr()` 2 is a 4000 x 2300 backing store, which is 6x the pixels of a
 * 1600 x 900 one, and a feature that costs nothing at the small size can be the
 * whole frame at the large one.
 *
 *   E2E_BENCH_W=2000 E2E_BENCH_H=1150 E2E_BENCH_DPR=2
 */
const WIDTH = Number(process.env.E2E_BENCH_W) || 1600;
const HEIGHT = Number(process.env.E2E_BENCH_H) || 900;
const DPR = Number(process.env.E2E_BENCH_DPR) || 1;

test.use({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: DPR,
  launchOptions: {
    args: [...GPU_ARGS, '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  },
});

/** Median and p95 of the interval between presented frames, in ms. */
async function measure(page: import('@playwright/test').Page, frames: number) {
  return page.evaluate(async (count) => {
    const bridge = (window as any).__VIBE_E2E__;
    const deltas: number[] = [];
    const gpu: number[] = [];
    let previous = performance.now();
    // Discard the first 30: toggling a feature recompiles materials and
    // reallocates render targets, and that lands in the first frames.
    for (let i = 0; i < count + 30; i += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const now = performance.now();
      if (i >= 30) {
        deltas.push(now - previous);
        const g = bridge.frameProfile().gpuFrameMs;
        if (g > 0) gpu.push(g);
      }
      previous = now;
    }
    deltas.sort((a, b) => a - b);
    gpu.sort((a, b) => a - b);
    const at = (f: number) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * f))];
    return {
      median: at(0.5),
      p95: at(0.95),
      fps: 1000 / at(0.5),
      // The number that decides whether a frame is GPU-bound, and the only one
      // here that a faster CPU cannot move.
      gpuMedian: gpu.length > 0 ? gpu[Math.floor(gpu.length / 2)] : 0,
    };
  }, frames);
}

test.describe('city render cost', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(360_000);

  test('prices each feature against the 120 fps budget', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    await resetCity(page);

    // Park in front of a building and stay there for every measurement.
    const targets = await allStructureTargets(page, 0.5);
    const here = (await snapshot(page)).position;
    const nearest = [...targets].sort((a, b) =>
      Math.hypot(a[0] - here[0], a[2] - here[2]) - Math.hypot(b[0] - here[0], b[2] - here[2]))[0];
    if (Math.hypot(nearest[0] - here[0], nearest[2] - here[2]) > 45) {
      await walkToward(page, [nearest[0], 0, nearest[2]], 45, { maxSteps: 25 });
    }
    await waitUntilStill(page);
    await aimAt(page, nearest);
    await parkOutside(page, await cityBounds(page), { standOffM: 26, heightM: 8, aimFraction: 0.2 });
    await page.waitForTimeout(1500);

    const results: Array<[string, Awaited<ReturnType<typeof measure>>]> = [];
    const record = async (label: string) => {
      results.push([label, await measure(page, FRAMES)]);
    };
    const set = async (next: { shadows?: boolean; ao?: boolean; tier?: 'fast' | 'pretty' }) => {
      await page.evaluate((n) => (window as any).__VIBE_E2E__.setRenderQuality(n), next);
      await page.waitForTimeout(1200);
    };
    // The debug panel is not free to have open: the city layer's 2 Hz telemetry
    // block composes a world pose for every chunk, and it runs only while
    // something is reading it. A measurement taken with the panel up is partly
    // measuring the panel, which is exactly the trap the reported numbers fell
    // into.
    const diagnostics = async (on: boolean) => {
      await page.evaluate((v) => (window as any).__VIBE_E2E__.setDiagnostics(v), on);
      await page.waitForTimeout(600);
    };

    await set({ tier: 'pretty', ao: true, shadows: true });
    await diagnostics(false);
    await record('AT REST   everything on, no panel');
    await diagnostics(true);
    await record('AT REST   everything on, PANEL OPEN');
    await diagnostics(false);

    // Now the case that actually matters. An idle city has nothing awake, so it
    // measures the draw path and none of the per-frame update path -- which is
    // what grows with a collapse and what the report was about.
    // Aim LOW and keep firing: the update path only loads when a lot of mass is
    // moving at once, and a hole punched mid-facade settles in under a second.
    // Taking a tower off its feet keeps thousands of chunks awake for long
    // enough to measure, which is the state the report came from.
    await page.evaluate(() => (window as any).__VIBE_E2E__.setCapturePose(null));
    const before = await cityStats(page);
    const base: [number, number, number] = [nearest[0], nearest[1] * 0.18, nearest[2]];
    await fireAt(page, base, 90, { intervalMs: 90 });
    const after = await cityStats(page);
    console.log(`[render cost] bonds broken ${before.brokenBonds} -> ${after.brokenBonds}, `
      + `awake ${before.chunksAwake} -> ${after.chunksAwake}`);
    await parkOutside(page, await cityBounds(page), { standOffM: 26, heightM: 8, aimFraction: 0.2 });
    const awake = (await cityStats(page)).chunksAwake;

    await record(`DEBRIS    everything on, no panel`);
    await diagnostics(true);
    await record('DEBRIS    everything on, PANEL OPEN');
    await diagnostics(false);
    await set({ ao: false });
    await record('DEBRIS    AO off');
    await set({ shadows: false });
    await record('DEBRIS    AO off, shadows off');

    // The 2 Hz telemetry block is O(chunks), not O(debris), so it is the one
    // client cost that can be measured repeatably without reproducing an
    // hours-long demolition. Sampled with the panel open, since that is what
    // makes it run at all.
    await diagnostics(true);
    await page.waitForTimeout(2500);
    const profile = await page.evaluate(async () => {
      const bridge = (window as any).__VIBE_E2E__;
      let telemetry = 0;
      let sample = 0;
      let city = 0;
      let gpu = 0;
      // telemetryMs is deliberately not reset per frame, so the useful figure is
      // the peak over a window that certainly contains a tick.
      for (let i = 0; i < 240; i += 1) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const p = bridge.frameProfile();
        if (p.telemetryMs > telemetry) telemetry = p.telemetryMs;
        sample += p.sampleMs;
        city += p.cityFrameMs;
        gpu += p.gpuFrameMs ?? 0;
      }
      return {
        telemetryMs: telemetry,
        sampleMs: sample / 240,
        cityFrameMs: city / 240,
        gpuFrameMs: gpu / 240,
      };
    });
    await diagnostics(false);
    console.log(
      `[render cost] 2 Hz telemetry block peak ${profile.telemetryMs.toFixed(2)} ms; `
      + `sample ${profile.sampleMs.toFixed(2)} ms/frame; city ${profile.cityFrameMs.toFixed(2)} ms/frame; `
      + `GPU ${profile.gpuFrameMs > 0 ? profile.gpuFrameMs.toFixed(2) + ' ms/frame' : 'n/a'}`,
    );

    const backing = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      return canvas ? `${canvas.width}x${canvas.height}` : 'unknown';
    });
    const budget = 1000 / 120;
    console.log(`\n[render cost] ${FRAMES} frames each, vsync off`);
    console.log(`[render cost] css ${WIDTH}x${HEIGHT} @ dpr ${DPR} -> backing store ${backing}`);
    console.log(`[render cost] chunks awake during DEBRIS rows: ${awake}`);
    console.log(`[render cost] 120 fps budget = ${budget.toFixed(2)} ms\n`);
    for (const [label, r] of results) {
      const verdict = r.median <= budget ? 'under' : `${(r.median / budget).toFixed(2)}x over`;
      console.log(
        `  ${label.padEnd(40)} ${r.median.toFixed(2)} ms frame  `
        + `${r.p95.toFixed(2)} p95  `
        + `${r.gpuMedian > 0 ? r.gpuMedian.toFixed(2) + ' ms GPU' : '  n/a GPU'}  `
        + `${r.fps.toFixed(0)} fps  [${verdict}]`,
      );
    }
    console.log('');
  });
});
