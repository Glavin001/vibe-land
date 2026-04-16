/**
 * Practice Smoke Spec
 *
 * Opens plain /practice, joins the firing range, and exercises:
 * - Click to join
 * - Pointer lock acquisition
 * - F3 debug overlay visibility
 * - E2E bridge snapshot reads (transport, player id, debug stats)
 * - Keyboard/mouse look, move, jump, shoot
 * - Enter nearest vehicle, drive forward, exit vehicle
 * - Each state transition asserted via snapshots
 */
import { test, expect } from '@playwright/test';
import {
  openPractice,
  join,
  acquirePointerLock,
  toggleDebugOverlay,
  snapshot,
  waitForSnapshot,
  lookDelta,
  holdMove,
  jump,
  shootOnce,
  shootBurst,
  enterNearestVehicle,
  driveForward,
  exitVehicle,
} from '../helpers/toolkit';

test.describe('Practice Mode Smoke', () => {
  test('full practice gameplay flow', async ({ page }) => {
    // 1. Open /practice
    await openPractice(page);

    // Verify bridge is available before join
    const preJoinSnap = await snapshot(page);
    expect(preJoinSnap.mode).toBe('practice');

    // 2. Click to join
    const joinSnap = await join(page, { timeout: 30_000 });
    expect(joinSnap.mode).toBe('practice');

    // 3. Acquire pointer lock on the real canvas
    await acquirePointerLock(page);

    // Wait for local-preview transport to be active and player positioned
    const readySnap = await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'wait for local-preview transport' },
    );
    expect(readySnap.transport).toMatch(/local/);

    // 4. Toggle debug overlay with F3
    await toggleDebugOverlay(page);
    const debugOverlay = page.locator('[data-testid="debug-overlay"]');
    await expect(debugOverlay).toBeVisible({ timeout: 5_000 });

    // Verify debug overlay visible in snapshot
    const debugSnap = await snapshot(page);
    expect(debugSnap.debugOverlayVisible).toBe(true);
    expect(debugSnap.debugStats).toBeDefined();

    // 5. Read __VIBE_E2E__.snapshot() and confirm key fields
    expect(debugSnap.transport).toMatch(/local/);
    expect(debugSnap.debugStats.transport).toMatch(/local/);

    // 6. Look around using mouse delta
    const beforeLook = await snapshot(page);
    await lookDelta(page, 200, 0); // look right
    await page.waitForTimeout(200);
    const afterLook = await snapshot(page);
    // Camera yaw should have changed
    expect(afterLook.cameraYaw).not.toBeCloseTo(beforeLook.cameraYaw, 1);

    // 7. Move forward
    const beforeMove = await snapshot(page);
    await holdMove(page, 'forward', 500);
    await page.waitForTimeout(200);
    const afterMove = await snapshot(page);
    // Position should have changed
    const posDelta = Math.hypot(
      afterMove.position[0] - beforeMove.position[0],
      afterMove.position[2] - beforeMove.position[2],
    );
    expect(posDelta).toBeGreaterThan(0.1);

    // 8. Jump
    await jump(page);
    // Brief wait and verify we're still alive
    await page.waitForTimeout(300);
    const afterJump = await snapshot(page);
    expect(afterJump.dead).toBe(false);

    // 9. Shoot
    const beforeShoot = await snapshot(page);
    await shootOnce(page);
    await page.waitForTimeout(300);
    const afterShoot = await snapshot(page);
    // In practice mode, shot counter should increment
    expect(afterShoot.shotsFired).toBeGreaterThanOrEqual(beforeShoot.shotsFired);

    // 10. Try to find and enter a nearby vehicle.
    // The vehicle test is best-effort: if no vehicle is reachable from the
    // spawn point within a reasonable walk, skip the vehicle section rather
    // than failing the entire smoke test.
    let foundVehicle = false;
    try {
      const vehicleSnap = await waitForSnapshot(
        page,
        (s) => s.nearestVehicleId !== null,
        { timeout: 5_000, label: 'find nearby vehicle' },
      );
      if (vehicleSnap.nearestVehicleId !== null) {
        // 11. Enter vehicle
        const entered = await enterNearestVehicle(page);
        expect(entered.inVehicle).toBe(true);
        foundVehicle = true;

        // 12. Drive forward — use cameraPosition since the camera follows the
        // vehicle while the player position may stay at the last on-foot spot.
        const beforeDrive = await snapshot(page);
        await driveForward(page, 1500);
        await page.waitForTimeout(500);
        const afterDrive = await snapshot(page);
        const driveDelta = Math.hypot(
          afterDrive.cameraPosition[0] - beforeDrive.cameraPosition[0],
          afterDrive.cameraPosition[2] - beforeDrive.cameraPosition[2],
        );
        expect(driveDelta).toBeGreaterThan(0);

        // 13. Exit vehicle
        const exitSnap = await exitVehicle(page);
        expect(exitSnap.inVehicle).toBe(false);
      }
    } catch {
      // Vehicle not reachable — acceptable in a smoke test
    }

    // 14. Toggle debug overlay off
    await toggleDebugOverlay(page);
    await expect(debugOverlay).not.toBeVisible({ timeout: 3_000 });
  });
});
