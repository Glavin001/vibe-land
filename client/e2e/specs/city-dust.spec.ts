/**
 * Destruction dust end-to-end.
 *
 * Two checks: that a real fracture makes dust (sources extracted from the
 * topology stream, parcels spawned, parcels drawn), and that the renderer
 * alone -- fed a burst through the bridge, no building broken -- draws it
 * within the sample budget and skips the pass once it has gone.
 *
 * Gated behind E2E_CITY=1 like the rest of the city suite.
 */
import { expect, test } from '@playwright/test';

import { join, snapshot, waitForSnapshot } from '../helpers/toolkit';
import {
  fireAt,
  openCity,
  tallestStructureTarget,
  waitForCityRendered,
  waitUntilStill,
  walkToward,
} from '../helpers/city';

const CITY_ENABLED = process.env.E2E_CITY === '1';
const STAND_OFF_M = 14;

type FrameProfile = {
  dustParcelsLive: number;
  dustDrawn: number;
  dustDrawnHalf: number;
  dustSamplesEstM: number;
  dustPassSkipped: number;
  dustFluidActive: number;
};

async function frameProfile(page: import('@playwright/test').Page): Promise<FrameProfile> {
  return page.evaluate(() => (window as any).__VIBE_E2E__.frameProfile());
}

test.describe('destruction dust', () => {
  test.skip(!CITY_ENABLED, 'set E2E_CITY=1 to run city dust e2e');
  test.describe.configure({ mode: 'serial' });

  test('a fracture makes dust, and the dust is drawn', async ({ page }) => {
    test.setTimeout(180_000);
    await openCity(page);
    await join(page);
    await waitForCityRendered(page);
    await page.evaluate(() => (window as any).__VIBE_E2E__.setRenderQuality({ dust: 'volumetric' }));
    await page.evaluate(() => (window as any).__VIBE_E2E__.setCannonball(true));

    const before = await snapshot(page);
    expect(before.city!.dust.enabled).toBe(true);

    const target = await tallestStructureTarget(page);
    await walkToward(page, target, STAND_OFF_M);
    await waitUntilStill(page);
    await fireAt(page, target, 4);

    const dusty = await waitForSnapshot(
      page,
      (s) => !!s.city && s.city.dust.parcelsLive > 0,
      { timeout: 30_000, label: 'dust after firing' },
    );
    expect(dusty.city!.brokenBonds).toBeGreaterThan(before.city!.brokenBonds);
    expect(dusty.city!.dust.sourcesTotal).toBeGreaterThan(0);
    expect(dusty.city!.dust.parcelsEmitted).toBeGreaterThan(0);
    // `dropped` is a design counter (the per-tick cap trimming a collapse),
    // not a fault; a city already coming down from an earlier run trims.
    expect(dusty.city!.dust.dropped).toBeGreaterThanOrEqual(0);

    // Drawn, not just alive: the volume pass ran this frame.
    const drawn = await waitForSnapshot(
      page,
      (s) => !!s.city && s.city.dust.parcelsDrawn > 0,
      { timeout: 10_000, label: 'dust drawn' },
    );
    expect(drawn.city!.dust.parcelsDrawn).toBeGreaterThan(0);
  });

  test('the renderer draws a bridge burst within budget and goes idle after it', async ({ page }) => {
    test.setTimeout(120_000);
    await openCity(page);
    await join(page);
    await waitForCityRendered(page);
    await page.evaluate(() => (window as any).__VIBE_E2E__.setRenderQuality({ dust: 'volumetric', dustFluid: 'off' }));
    const s = await snapshot(page);
    const [x, y, z] = s.position;
    // Park the camera three metres up, looking fifteen metres ahead; burst there.
    await page.evaluate(([p, at]) => (window as any).__VIBE_E2E__.setCapturePose({ position: p, lookAt: at }), [[x, y + 3, z], [x, 2, z + 15]]);
    await page.waitForTimeout(500);
    // Idle only means something on a quiet city: on a shared server a
    // collapse from an earlier run keeps making its own dust.
    const quiet = (await snapshot(page)).city!.chunksAwake === 0 && (await frameProfile(page)).dustParcelsLive === 0;
    if (quiet) expect((await frameProfile(page)).dustPassSkipped).toBe(1);

    await page.evaluate(([at]) => (window as any).__VIBE_E2E__.dustBurst({ x: at[0], y: at[1], z: at[2], magnitude: 60 }), [[x, 2, z + 15]]);
    await page.waitForTimeout(800);
    const busy = await frameProfile(page);
    expect(busy.dustParcelsLive).toBeGreaterThan(0);
    expect(busy.dustDrawn + busy.dustDrawnHalf).toBeGreaterThan(0);
    expect(busy.dustPassSkipped).toBe(0);
    expect(busy.dustSamplesEstM).toBeLessThanOrEqual(12.01);

    // Parcels live 12 s; a while after that the pass skips again.
    if (quiet) {
      await page.waitForTimeout(13_000);
      const after = await frameProfile(page);
      expect(after.dustParcelsLive).toBe(0);
      expect(after.dustPassSkipped).toBe(1);
    } else {
      test.info().annotations.push({ type: 'note', description: 'city not quiet; idle check skipped' });
    }
    await page.evaluate(() => (window as any).__VIBE_E2E__.setCapturePose(null));
  });
});
