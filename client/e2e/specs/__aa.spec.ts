import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { cityBounds, hideDomOverlays, openCity, parkOutside, resetCity, waitForCityRendered } from '../helpers/city';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../aa-check');
test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

test('aa on vs off', async ({ page }) => {
  test.setTimeout(180_000);
  await openCity(page);
  await waitForCityRendered(page);
  await page.waitForFunction(() => (window as any).__VIBE_CITY_TEX_READY__ === true, { timeout: 60_000 });
  await resetCity(page);
  await hideDomOverlays(page);
  await parkOutside(page, await cityBounds(page), { standOffM: 25, heightM: 10, aimFraction: 0.35 });
  const bridge = '(window as any)';
  for (const samples of [4, 0]) {
    await page.evaluate((n) => {
      // session-only setter is not on the bridge; reach the store via the sweep path
      (window as any).__VIBE_E2E__.runPerfSweep; // noop keep
      return (window as any).__VIBE_SET_AO_MSAA__?.(n);
    }, samples);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(DIR, `msaa${samples}.png`) });
  }
});
