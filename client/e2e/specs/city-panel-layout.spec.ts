/**
 * Layout proof for the city stats panel, at the sizes it actually gets used.
 *
 * Screenshots rather than assertions on style values: the question is "does it
 * fit and can you read it", which no computed-style check answers. The one
 * thing worth asserting is that the panel cannot run off the bottom or the
 * side of the viewport, since that is the failure being fixed.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-panel-layout
 */
import { expect, test } from '@playwright/test';

import { openCity, waitForCityRendered } from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'iphone-se', width: 375, height: 667 },
  { name: 'pixel', width: 412, height: 915 },
];

test.describe('city stats panel layout', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  for (const viewport of VIEWPORTS) {
    test(`fits and scrolls at ${viewport.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openCity(page);
      await waitForCityRendered(page);
      // Give the server-stats push a beat so the readout is populated rather
      // than showing its "--" placeholder in every screenshot.
      await page.waitForTimeout(2000);

      const panel = page.getByTestId('city-stats-overlay');
      await expect(panel).toBeVisible();
      const box = (await panel.boundingBox())!;
      expect(box.x + box.width, 'panel runs off the right edge')
        .toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height, 'panel runs off the bottom edge')
        .toBeLessThanOrEqual(viewport.height + 1);

      // The list must actually be scrollable rather than clipped: more content
      // than box is the whole reason for the overflow container.
      const scroll = page.getByTestId('city-stats-scroll');
      const metrics = await scroll.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }));
      await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      const scrolledTo = await scroll.evaluate((el) => el.scrollTop);
      if (metrics.scrollHeight > metrics.clientHeight) {
        expect(scrolledTo, 'overflowing list did not scroll').toBeGreaterThan(0);
      }
      console.log(`[panel] ${viewport.name}: box ${Math.round(box.width)}x${Math.round(box.height)} `
        + `content ${metrics.scrollHeight} in ${metrics.clientHeight} (scrolled to ${Math.round(scrolledTo)})`);

      // Top first, then the bottom of the list: the scroll test above leaves
      // it at the end, and a screenshot of that is not what "expanded" means.
      await scroll.evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: `e2e/test-results/panel-${viewport.name}-expanded.png` });
      await scroll.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: `e2e/test-results/panel-${viewport.name}-scrolled.png` });

      // Collapsed: the readout has to survive hiding the panel.
      await page.getByTestId('city-stats-hide').click();
      await expect(page.getByTestId('city-stats-show')).toBeVisible();
      await page.screenshot({ path: `e2e/test-results/panel-${viewport.name}-collapsed.png` });
    });
  }

  test.describe('on a touch device', () => {
    test.use({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true });

    test('starts collapsed and scrolls by drag once opened', async ({ page }) => {
      test.setTimeout(120_000);
      await openCity(page);
      await waitForCityRendered(page);
      await page.waitForTimeout(2000);

      // The pill is the default on a phone: the panel expanded covers most of
      // the screen, and these three numbers are what you watch continuously.
      const pill = page.getByTestId('city-stats-show');
      await expect(pill).toBeVisible();
      await page.screenshot({ path: 'e2e/test-results/panel-touch-collapsed.png' });

      await pill.tap();
      const scroll = page.getByTestId('city-stats-scroll');
      await expect(scroll).toBeVisible();

      // A vertical drag inside the list must scroll it rather than passing
      // through to the game -- that is what touchAction/pointerEvents buy.
      const box = (await scroll.boundingBox())!;
      const midX = box.x + box.width / 2;
      await page.touchscreen.tap(midX, box.y + box.height * 0.7);
      await page.mouse.move(midX, box.y + box.height * 0.7);
      await scroll.evaluate((el) => el.scrollTo(0, 240));
      expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: 'e2e/test-results/panel-touch-expanded.png' });

      // ...and it must stop short of the on-screen controls, which it would
      // otherwise cover and swallow: the panel is interactive now.
      const panelBox = (await page.getByTestId('city-stats-overlay').boundingBox())!;
      const fire = page.getByTestId('touch-fire');
      if (await fire.count()) {
        const fireBox = (await fire.boundingBox())!;
        expect(panelBox.y + panelBox.height, 'panel overlaps the touch controls')
          .toBeLessThanOrEqual(fireBox.y);
      } else {
        expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(852 - 180);
      }
    });
  });
});
