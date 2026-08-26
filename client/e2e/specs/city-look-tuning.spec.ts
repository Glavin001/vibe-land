/**
 * Sweep the perceptual lighting knobs from one camera.
 *
 * Three complaints drove this, all of them look-at-it calls: too much fog at
 * distance, a washed-out background, and contact shading strong enough that
 * every chunk reads as outlined rather than shaded.
 *
 * Fog and AO have to be judged together. Fog erases the distant contrast AO is
 * drawing, so lowering one changes what the other should be -- which is also
 * why they are swept from ONE parked camera in ONE session. Rebuilding between
 * candidates re-rolls the spawn, and in a 21 m street grid at this fog density
 * which way the camera faces matters more than any of these values.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-look-tuning
 */
import { test } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  cityBounds,
  hideDomOverlays,
  openCity,
  parkOutside,
  resetCity,
  waitForCityRendered,
} from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1';
const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../look-tuning');

type Look = { fogIntensity: number; aoStrength: number; envIntensity: number };

/**
 * `a` is what shipped. The rest walk the two axes the complaints named: fog
 * intensity below 1 pushes the 99%-opacity point past the 80 m AOI radius, and
 * aoStrength is the exponent that decides whether contact shading reads as
 * shading or as an outline.
 */
const CANDIDATES: Array<[string, Look]> = [
  ['a-shipped-fog1.00-ao1.50', { fogIntensity: 1.0, aoStrength: 1.5, envIntensity: 1 }],
  ['b-fog0.55-ao1.50', { fogIntensity: 0.55, aoStrength: 1.5, envIntensity: 1 }],
  ['c-fog0.55-ao0.90', { fogIntensity: 0.55, aoStrength: 0.9, envIntensity: 1 }],
  ['d-fog0.40-ao0.90', { fogIntensity: 0.40, aoStrength: 0.9, envIntensity: 1 }],
  ['e-fog0.40-ao0.60', { fogIntensity: 0.40, aoStrength: 0.6, envIntensity: 1 }],
  ['f-fog0.40-ao0.90-env0.85', { fogIntensity: 0.40, aoStrength: 0.9, envIntensity: 0.85 }],
];

test.use({ viewport: { width: 1600, height: 900 } });

test.describe('city look tuning', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(360_000);

  test('photographs the fog/AO grid from one camera', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);
    await page.waitForFunction(
      () => (window as unknown as { __VIBE_CITY_TEX_READY__?: boolean })
        .__VIBE_CITY_TEX_READY__ === true,
      { timeout: 60_000 },
    );
    await resetCity(page);
    await hideDomOverlays(page);

    // Two vantages, because the complaints live at different ranges. The fog
    // one is only visible with the whole skyline in frame; the contact-shading
    // one is only visible close enough for AO to still be faded in at all
    // (it fades out between 60 m and 140 m).
    const bounds = await cityBounds(page);
    const VANTAGES: Array<[string, Parameters<typeof parkOutside>[2]]> = [
      ['skyline', { standOffM: 70, heightM: 26, aimFraction: 0.42 }],
      ['street', { standOffM: 16, heightM: 4, aimFraction: 0.12 }],
    ];

    for (const [vantage, options] of VANTAGES) {
      await parkOutside(page, bounds, options);
      for (const [name, look] of CANDIDATES) {
        await page.evaluate((l) => (window as any).__VIBE_E2E__.setLook(l), look);
        await page.waitForTimeout(700);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${vantage}-${name}.png`) });
      }
    }
  });
});
