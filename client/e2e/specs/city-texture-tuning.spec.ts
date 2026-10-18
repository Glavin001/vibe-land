/**
 * Tuning sweep for the city's concrete: grain size and overall tone.
 *
 * Both are look-at-it decisions with no computable answer, and both are live
 * uniforms (`window.__VIBE_CITY_TEX__`), so a single session can photograph the
 * whole grid from one camera instead of rebuilding per candidate. Run it, look
 * at the contact sheet, put the winner in `cityMaterialShader`'s defaults.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-texture-tuning
 */
import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  aimAt,
  hideDomOverlays,
  openCity,
  resetCity,
  tallestStructureTarget,
  waitForCityRendered,
  waitUntilStill,
  walkToward,
} from '../helpers/city';
import { snapshot } from '../helpers/toolkit';

const ENABLED = process.env.E2E_CITY === '1';
const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../texture-tuning');

const CANDIDATES = [
  { name: 'a-scale1.0-tone1.00', scale: 1.0, tone: 1.0 },
  { name: 'b-scale2.0-tone0.80', scale: 2.0, tone: 0.8 },
  { name: 'c-scale2.5-tone0.70', scale: 2.5, tone: 0.7 },
  { name: 'd-scale3.5-tone0.62', scale: 3.5, tone: 0.62 },
  { name: 'e-scale2.5-cool', scale: 2.5, tone: [0.60, 0.62, 0.66] as [number, number, number] },
];

test.use({ video: 'off', viewport: { width: 1280, height: 720 } });

test.describe('city concrete tuning', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  // Two walked vantages plus ten captures does not fit the suite default: the
  // drive bridge has no teleport, so repositioning is real walking.
  test.setTimeout(360_000);

  test('photographs the grain/tone grid from two ranges', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    // The server keeps the last run's rubble, and these shots are about
    // intact buildings.
    await resetCity(page);
    await hideDomOverlays(page);
    // The stats panel covers the left third, and this sweep is only about how
    // the surface reads.

    const target = await tallestStructureTarget(page, 0.45);

    for (const range of [70, 30]) {
      const here = (await snapshot(page)).position;
      const dx = here[0] - target[0];
      const dz = here[2] - target[2];
      const away = Math.max(1e-3, Math.hypot(dx, dz));
      await walkToward(
        page,
        [target[0] + (dx / away) * range, 0, target[2] + (dz / away) * range],
        3,
        { maxSteps: 40 },
      );
      await waitUntilStill(page);
      await aimAt(page, [target[0], target[1] * 0.6, target[2]]);
      await page.waitForTimeout(1000);

      for (const candidate of CANDIDATES) {
        await page.evaluate(
          (next) => (window as any).__VIBE_CITY_TEX__(next),
          { scale: candidate.scale, tone: candidate.tone },
        );
        await page.waitForTimeout(400);
        await page.screenshot({
          path: path.join(SHOTS_DIR, `${range}m-${candidate.name}.png`),
        });
      }
    }
  });
});
