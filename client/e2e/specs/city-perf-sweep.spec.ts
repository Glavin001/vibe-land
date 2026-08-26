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
      steps: Array<{ label: string; gpuMs: { median: number }; frameMs: { median: number } }>;
    };

    console.log(`\n[perf sweep] gpu: ${report.gpu}`);
    console.log(`[perf sweep] backing store: ${report.backingStore}`);
    for (const step of report.steps) {
      console.log(
        `  ${step.label.padEnd(30)} frame ${step.frameMs.median.toFixed(2)} ms   `
        + `gpu ${step.gpuMs.median.toFixed(2)} ms`,
      );
    }

    expect(report.steps.length).toBe(10);
    expect(report.gpuTimingAvailable, 'no GPU timing — the sweep cannot answer what it is for')
      .toBe(true);
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
