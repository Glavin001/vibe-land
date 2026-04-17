import { expect, test } from '@playwright/test';
import {
  acquirePointerLock,
  driveForward,
  enterNearestVehicle,
  join,
  openPractice,
  snapshot,
  waitForSnapshot,
} from '../helpers/toolkit';

/**
 * Browser-exact regression for the destructible-wall failure reported in
 * `/practice`.
 *
 * User flow under test:
 * 1. Open `/practice`
 * 2. Join the local session
 * 3. Enter the nearby vehicle
 * 4. Hold forward and ram the wall straight ahead
 *
 * Expected behavior:
 * - the wall fractures from the car impact
 * - the resulting debris behaves like separated rigid chunks
 * - chunks do not visually or physically collapse into the same space
 *
 * What this test is intended to catch:
 * - post-fracture chunk pairs ending up nearly co-located
 * - large AABB overlap between sibling debris chunks
 * - debris falling below the ground plane after the impact settles
 *
 * What needs to be fixed when this test fails:
 * - the destructible split / migration path must preserve spatially
 *   separated chunk poses after fracture
 * - or the browser-visible chunk transform source must be corrected so
 *   it reflects the true Rapier collider poses instead of an invalid
 *   post-split reconstruction
 */
test.describe('Practice Destructibles', () => {
  /**
   * The assertion on `significantOverlapPairCount` is the primary bug
   * detector. A non-zero value means the browser is still rendering or
   * receiving debris chunks that occupy the same world-space volume after
   * the wall breaks, which is the exact regression this spec exists to
   * reproduce.
   */
  test('driving into the practice wall leaves fractured debris spatially separated', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    const ready = await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'practice sim ready' },
    );
    expect(ready.destructibles.chunkCount).toBeGreaterThan(0);
    expect(ready.destructibles.debugConfig.debrisCollisionMode).toBe('all');

    await waitForSnapshot(
      page,
      (s) => s.nearestVehicleId !== null,
      { timeout: 10_000, label: 'nearest vehicle available' },
    );
    const entered = await enterNearestVehicle(page);
    expect(entered.inVehicle).toBe(true);

    const beforeDrive = await snapshot(page);
    expect(beforeDrive.destructibles.debugState.contactEventsAcceptedTotal).toBe(0);

    await driveForward(page, 2500);

    const afterImpact = await waitForSnapshot(
      page,
      (s) => (
        s.destructibles.debugState.contactEventsMatchingTotal > 0
        && s.destructibles.fractureEventsTotal > 0
      ),
      { timeout: 10_000, label: 'destructible impact telemetry' },
    );

    expect(afterImpact.destructibles.debugState.contactEventsSeenTotal).toBeGreaterThan(0);
    expect(afterImpact.destructibles.debugState.contactEventsMatchingTotal).toBeGreaterThan(0);
    expect(afterImpact.destructibles.debugState.contactEventsAcceptedTotal).toBeGreaterThan(0);
    expect(afterImpact.destructibles.fractureEventsTotal).toBeGreaterThan(0);
    expect(afterImpact.cameraPosition[2]).toBeGreaterThan(beforeDrive.cameraPosition[2]);

    await page.waitForTimeout(3_000);

    const settled = await waitForSnapshot(
      page,
      (s) => s.destructibles.fractureEventsTotal > 0,
      { timeout: 5_000, label: 'fractured debris settle window' },
    );

    expect(
      settled.destructibles.spatialMetrics.significantOverlapPairCount,
      JSON.stringify(settled.destructibles.spatialMetrics.sampleOverlapPairs, null, 2),
    ).toBe(0);
    expect(settled.destructibles.spatialMetrics.nearCoincidentPairCount).toBe(0);
    expect(settled.destructibles.spatialMetrics.maxOverlapPenetrationM).toBeLessThan(0.05);
    expect(settled.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-0.05);
  });
});
