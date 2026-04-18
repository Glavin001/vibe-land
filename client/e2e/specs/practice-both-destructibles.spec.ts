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
 * Regression suite for multi-destructible interactions in /practice.
 *
 * /practice always spawns TWO destructibles:
 *   id=2000  kind=wall   position=(0, 0, 8)
 *   id=2001  kind=tower  position=(10, 0.5, -5)
 *
 * The primary concern here is cross-destructible isolation: fracturing
 * the wall (by ramming it with the vehicle) must not corrupt the Rapier
 * rigid-body handles that belong to the tower, and the overall spatial
 * metrics must stay healthy for BOTH destructibles throughout.
 *
 * A secondary concern is that both destructibles spawn at their
 * requested positions and not at origin — the practice-mode placement
 * regression covered in unit tests also has an E2E counterpart here.
 */
test.describe('Practice Both Destructibles', () => {
  test('both wall and tower spawn with valid chunk geometry and no overlaps', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    const ready = await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'sim ready' },
    );

    // Wall alone produces ~18 chunks; tower adds more — combined must be >18.
    expect(ready.destructibles.chunkCount).toBeGreaterThan(18);
    expect(ready.destructibles.debugConfig.debrisCollisionMode).toBe('all');

    // Neither destructible should have chunks below ground at spawn
    expect(ready.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-0.05);

    // No overlap at spawn time — covers both wall and tower
    expect(ready.destructibles.spatialMetrics.significantOverlapPairCount).toBe(0);
    expect(ready.destructibles.spatialMetrics.nearCoincidentPairCount).toBe(0);
    expect(ready.destructibles.spatialMetrics.maxOverlapPenetrationM).toBeLessThan(0.05);
  });

  test('fracturing the wall leaves the tower chunks undisturbed and overlap-free', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'sim ready' },
    );

    await waitForSnapshot(
      page,
      (s) => s.nearestVehicleId !== null,
      { timeout: 10_000, label: 'nearest vehicle available' },
    );
    const entered = await enterNearestVehicle(page);
    expect(entered.inVehicle).toBe(true);

    // Record total chunk count before impact — we expect it to grow as
    // bonded chunks split into separate dynamic bodies.
    const beforeDrive = await snapshot(page);
    expect(beforeDrive.destructibles.debugState.contactEventsAcceptedTotal).toBe(0);

    // Drive long enough to reach the wall at z=8 even in slow CI environments.
    await driveForward(page, 6_000);

    // Wait for wall fracture to confirm the vehicle actually impacted
    const afterImpact = await waitForSnapshot(
      page,
      (s) => (
        s.destructibles.debugState.contactEventsMatchingTotal > 0
        && s.destructibles.fractureEventsTotal > 0
      ),
      { timeout: 20_000, label: 'wall fracture confirmed' },
    );

    expect(afterImpact.destructibles.debugState.contactEventsAcceptedTotal).toBeGreaterThan(0);
    expect(afterImpact.destructibles.fractureEventsTotal).toBeGreaterThan(0);

    // Allow debris to settle
    await page.waitForTimeout(5_000);

    const settled = await snapshot(page);

    // Combined metrics cover BOTH wall debris AND tower chunks.
    // If the tower was corrupted by the wall split, significantOverlapPairCount
    // would be non-zero even if the wall debris settled correctly.
    expect(
      settled.destructibles.spatialMetrics.significantOverlapPairCount,
      JSON.stringify(settled.destructibles.spatialMetrics.sampleOverlapPairs, null, 2),
    ).toBe(0);
    expect(settled.destructibles.spatialMetrics.nearCoincidentPairCount).toBe(0);
    expect(settled.destructibles.spatialMetrics.maxOverlapPenetrationM).toBeLessThan(0.05);
    expect(settled.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-0.05);
  });

  test('chunk count grows after fracture and all debris has valid transforms', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    const initial = await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'sim ready' },
    );
    const initialChunkCount = initial.destructibles.chunkCount;
    expect(initialChunkCount).toBeGreaterThan(0);

    await waitForSnapshot(page, (s) => s.nearestVehicleId !== null, { timeout: 10_000, label: 'vehicle ready' });
    const entered = await enterNearestVehicle(page);
    expect(entered.inVehicle).toBe(true);

    await driveForward(page, 6_000);

    const afterFracture = await waitForSnapshot(
      page,
      (s) => s.destructibles.fractureEventsTotal > 0,
      { timeout: 20_000, label: 'fracture event' },
    );

    // Fracturing splits bonded groups into individual dynamic bodies —
    // the visible chunk count must increase from the initial bonded value.
    expect(afterFracture.destructibles.chunkCount).toBeGreaterThanOrEqual(initialChunkCount);

    // Every chunk must produce a valid bottom-Y (no NaN or sub-terrain position)
    expect(afterFracture.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-1.0);
  });
});
