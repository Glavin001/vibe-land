/**
 * A mesh rebuild over existing rubble must not resurrect the buildings.
 *
 * The static shell bakes REST poses, and a rebuild does not always happen
 * against an intact city: threshold and texture-detail changes rebuild
 * mid-game, and a late joiner's first build happens over whatever is already
 * demolished. The regression this pins: after such a rebuild, every settled
 * island's chunks were drawn as the un-broken shell -- ghost buildings
 * standing over their own rubble -- until some repaint happened by luck.
 * Found because a perf report's mid-rubble rebuild rows drew a suspiciously
 * intact city.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-shell-rebuild
 */
import { expect, test } from '@playwright/test';

import {
  allStructureTargets,
  cityStats,
  fireAt,
  openCity,
  resetCity,
  waitForCityRendered,
} from '../helpers/city';
import { snapshot } from '../helpers/toolkit';

const ENABLED = process.env.E2E_CITY === '1';

test.use({ viewport: { width: 1280, height: 720 } });

test.describe('shell rebuild over rubble', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 with a city server running');
  test.setTimeout(300_000);

  test('rebuilding mid-rubble wakes every broken chunk', async ({ page }) => {
    const wokeLines: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('woke pre-broken chunks')) wokeLines.push(message.text());
    });

    await openCity(page);
    await waitForCityRendered(page);
    await resetCity(page);

    // Break a meaningful amount of city.
    const targets = await allStructureTargets(page, 0.35);
    const here = (await snapshot(page)).position;
    const nearest = [...targets].sort((a, b) =>
      Math.hypot(a[0] - here[0], a[2] - here[2]) - Math.hypot(b[0] - here[0], b[2] - here[2]))[0];
    await fireAt(page, nearest, 20, { intervalMs: 130 });
    await page.waitForTimeout(4000);
    const broken = (await cityStats(page)).brokenBonds;
    expect(broken, 'the barrage broke nothing, so a rebuild proves nothing').toBeGreaterThan(50);

    const trianglesBefore = await page.evaluate(
      () => (window as any).__VIBE_E2E__.frameProfile().triangles,
    );

    // A threshold change is the cheapest way to force a full mesh rebuild.
    await page.evaluate(
      () => (window as any).__VIBE_E2E__.setRenderQuality({ shareThreshold: 32 }),
    );
    await page.waitForTimeout(4000);

    const trianglesAfter = await page.evaluate(
      () => (window as any).__VIBE_E2E__.frameProfile().triangles,
    );

    // The wake pass must have fired and reported work...
    expect(wokeLines.length, 'no post-build wake ran').toBeGreaterThan(0);
    // ...and the drawn triangle count must survive the rebuild. Ghost mode
    // reads LOW: the rubble's instances stay hidden while only the shell
    // draws, dropping thousands of triangles. Different threshold = slightly
    // different instanced/batched split, so exact equality is wrong; 3% is far
    // below the ghost signature and above the split jitter.
    expect(Math.abs(trianglesAfter - trianglesBefore) / trianglesBefore).toBeLessThan(0.03);

    await page.evaluate(
      () => (window as any).__VIBE_E2E__.setRenderQuality({ shareThreshold: 8 }),
    );
  });
});
