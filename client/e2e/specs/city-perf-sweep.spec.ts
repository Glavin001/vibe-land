/**
 * Does the panel's cost sweep still produce sane numbers?
 *
 * The sweep exists to be run on someone else's hardware and mailed back, which
 * makes it exactly the kind of tool that can rot unnoticed: a broken harness
 * reports a table of plausible-looking zeros and everyone reasons from it. This
 * asserts the shape -- every step measured, GPU timing present, and turning
 * everything off measurably cheaper than leaving it on.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-perf-sweep
 */
import { expect, test } from '@playwright/test';

import {
  cityBounds,
  openCity,
  parkOutside,
  resetCity,
  waitForCityRendered,
} from '../helpers/city';
import { GPU_ARGS } from '../helpers/gpuArgs';

const ENABLED = process.env.E2E_CITY === '1';

test.use({
  viewport: { width: 1600, height: 900 },
  // dpr 2, because the sweep's dpr steps are CAPS: at the Playwright default
  // deviceScaleFactor of 1, min(devicePixelRatio, cap) is 1 whatever the cap,
  // no resize ever happens, and the backing-store proof below cannot pass.
  deviceScaleFactor: 2,
  // Without this the frame column is pinned at the refresh period and the whole
  // table reads as "everything costs 16.7 ms".
  launchOptions: { args: [...GPU_ARGS, '--disable-gpu-vsync', '--disable-frame-rate-limit'] },
});

test.describe('city perf sweep', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(360_000);

  test('measures every step, with real GPU time', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    await resetCity(page);
    await parkOutside(page, await cityBounds(page), { standOffM: 20, heightM: 6, aimFraction: 0.2 });

    const report = await page.evaluate(
      () => (window as any).__VIBE_E2E__.runPerfSweep(),
    ) as {
      gpu: string;
      backingStore: string;
      gpuTimingAvailable: boolean;
      unstable: boolean;
      presentPeriodMs: number;
      framePaced: boolean;
      sentinel: { gpuMs: { median: number } };
      steps: Array<{
        label: string;
        gpuMs: { median: number };
        frameMs: { median: number };
        drawCalls: number;
        subDraws: number;
        backingStore: string;
      }>;
    };

    console.log(`\n[perf sweep] gpu: ${report.gpu}`);
    console.log(`[perf sweep] backing store: ${report.backingStore}`);
    for (const step of report.steps) {
      console.log(
        `  ${step.label.padEnd(30)} frame ${step.frameMs.median.toFixed(2)} ms   `
        + `gpu ${step.gpuMs.median.toFixed(2)} ms   `
        + `${step.drawCalls} draws / ${step.subDraws} subdraws`,
      );
    }

    expect(report.steps.length).toBe(16);
    // The whole point of the last rework: a run that drifted mid-sweep must
    // say so rather than be reasoned from. On an idle test box it never should.
    expect(report.unstable, 'sweep flagged itself unstable on an idle box').toBe(false);
    // And a dpr step must PROVE it resized, not assume it.
    const dprStep = report.steps.find((s) => s.label === 'dpr cap 1.0');
    expect(dprStep?.backingStore).not.toBe(report.steps[0].backingStore);
    expect(report.gpuTimingAvailable, 'no GPU timing — the sweep cannot answer what it is for')
      .toBe(true);
    // The cadence this page is actually presented at, which qualifies every
    // frame median in the table. A 0 here silently un-qualifies them again.
    console.log(`[perf sweep] presented every ${report.presentPeriodMs.toFixed(2)} ms`);
    expect(report.presentPeriodMs, 'present period not measured').toBeGreaterThan(0);
    // This box runs with vsync disabled, so it must NOT read as frame-paced --
    // if it does, the check is firing on something other than pacing.
    expect(report.framePaced, 'idle vsync-disabled box read as frame-paced').toBe(false);
    for (const step of report.steps) {
      expect(step.frameMs.median, `${step.label} did not measure`).toBeGreaterThan(0);
      expect(step.gpuMs.median, `${step.label} has no GPU time`).toBeGreaterThan(0);
    }
    const asConfigured = report.steps[0];
    const floor = report.steps[report.steps.length - 1];
    expect(floor.gpuMs.median, 'turning everything off was not cheaper')
      .toBeLessThan(asConfigured.gpuMs.median);
  });
});

/**
 * The mobile profile, which exists precisely because it runs where the other
 * one cannot -- and is therefore the version most likely to rot unseen. This
 * box has a GPU timer and a fast GPU, so it cannot reproduce a phone; what it
 * CAN prove is that the short profile completes, measures every step, restores
 * what it touched, and that its screenshot-shaped summary is not a wall of
 * zeros. Whether shadows cost 20 ms is a question only the phone can answer.
 */
test.describe('city perf sweep (mobile profile)', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(240_000);

  test('runs the short profile and summarises it for a phone screen', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    await resetCity(page);
    await parkOutside(page, await cityBounds(page), { standOffM: 20, heightM: 6, aimFraction: 0.2 });

    const before = await page.evaluate(
      () => (window as any).__VIBE_E2E__.renderSettings?.() ?? null,
    );

    const { report, summary } = await page.evaluate(async () => {
      const api = (window as any).__VIBE_E2E__;
      const result = await api.runPerfSweep('mobile');
      return { report: result, summary: api.formatPerfSweepMobile(result) as string[] };
    }) as {
      report: {
        profile: string;
        unstable: boolean;
        steps: Array<{ label: string; frameMs: { median: number }; backingStore: string }>;
      };
      summary: string[];
    };

    console.log(`\n[mobile sweep]\n${summary.join('\n')}`);

    expect(report.profile).toBe('mobile');
    expect(report.steps.length).toBe(8);
    expect(report.unstable, 'mobile sweep flagged itself unstable on an idle box').toBe(false);
    for (const step of report.steps) {
      expect(step.frameMs.median, `${step.label} did not measure`).toBeGreaterThan(0);
    }
    // The dpr steps must prove they resized, exactly as in the full sweep --
    // a phone report whose resolution rows are silently no-ops is worse than
    // no report, because it argues AGAINST the lever most likely to work.
    const dpr = report.steps.find((s) => s.label === 'dpr cap 1.0');
    expect(dpr?.backingStore).not.toBe(report.steps[0].backingStore);
    // The summary is the entire deliverable on a phone: it has to carry the
    // baseline, one line per lever, and real numbers.
    expect(summary.join('\n')).toContain('baseline');
    expect(summary.filter((line) => /-?\d+\.\d+ms/.test(line).valueOf()).length)
      .toBeGreaterThanOrEqual(6);

    // And it must put back what it found -- a sweep that leaves the phone on
    // dpr 0.75 would look like the sweep "fixed" performance.
    const after = await page.evaluate(
      () => (window as any).__VIBE_E2E__.renderSettings?.() ?? null,
    );
    expect(after).toEqual(before);
  });
});
