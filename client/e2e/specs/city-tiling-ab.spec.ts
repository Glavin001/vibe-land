/**
 * A/B evidence for the anti-tiling stack: hero vs plain from parked cameras.
 *
 * The tiling complaint is perceptual, so the record of whether the stack works
 * is a pair of screenshots from the same camera, not a number. Output lands in
 * e2e/hero-ab/ (gitignored); crop the facade pair to wall scale to judge.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-tiling-ab
 */
import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { cityBounds, hideDomOverlays, openCity, parkOutside, resetCity, waitForCityRendered } from '../helpers/city';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hero-ab');
test.use({ viewport: { width: 1600, height: 900 } });

const ENABLED = process.env.E2E_CITY === '1';
test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
test('hero vs plain from three vantages', async ({ page }) => {
  test.setTimeout(300_000);
  await openCity(page);
  await waitForCityRendered(page);
  await page.waitForFunction(() => (window as any).__VIBE_CITY_TEX_READY__ === true, { timeout: 60_000 });
  await resetCity(page);
  await hideDomOverlays(page);
  const bounds = await cityBounds(page);
  const V: Array<[string, Parameters<typeof parkOutside>[2]]> = [
    ['facade12m', { standOffM: 12, heightM: 5, aimFraction: 0.12 }],
    ['street30m', { standOffM: 30, heightM: 8, aimFraction: 0.22 }],
    ['skyline70m', { standOffM: 70, heightM: 24, aimFraction: 0.40 }],
  ];
  for (const [name, opts] of V) {
    await parkOutside(page, bounds, opts);
    for (const hero of [true, false]) {
      await page.evaluate((h) => (window as any).__VIBE_E2E__.setRenderQuality({ heroTiling: h }), hero);
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(DIR, `${name}-${hero ? 'hero' : 'plain'}.png`) });
    }
  }
  await page.evaluate(() => (window as any).__VIBE_E2E__.setRenderQuality({ heroTiling: true }));
});
