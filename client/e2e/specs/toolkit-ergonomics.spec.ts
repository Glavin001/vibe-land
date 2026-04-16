/**
 * Toolkit Ergonomics Spec
 *
 * Demonstrates that tests can be written using only the high-level toolkit
 * helpers, producing specs that read as concise gameplay steps rather than
 * raw Playwright key presses.
 *
 * This spec is intentionally short and readable to validate the toolkit API.
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
} from '../helpers/toolkit';

test.describe('Toolkit Ergonomics', () => {
  test('practice session using only toolkit helpers', async ({ page }) => {
    // Open the firing range and join
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    // Wait until the game simulation is running
    await waitForSnapshot(page, (s) => s.transport === 'local-preview' || s.transport === 'local', {
      timeout: 15_000,
      label: 'simulation running',
    });

    // Turn on the debug overlay
    await toggleDebugOverlay(page);
    const snap1 = await snapshot(page);
    expect(snap1.debugOverlayVisible).toBe(true);

    // Look around
    await lookDelta(page, 150, -50);

    // Walk forward and verify movement
    const before = await snapshot(page);
    await holdMove(page, 'forward', 600);
    const after = await snapshot(page);
    const distance = Math.hypot(
      after.position[0] - before.position[0],
      after.position[2] - before.position[2],
    );
    expect(distance).toBeGreaterThan(0.1);

    // Jump
    await jump(page);
    await page.waitForTimeout(200);

    // Shoot a burst
    await shootBurst(page, 3);
    const postShoot = await snapshot(page);
    expect(postShoot.shotsFired).toBeGreaterThan(0);

    // Strafe left
    await holdMove(page, 'left', 400);

    // Look the other way
    await lookDelta(page, -300, 20);

    // Move backward
    await holdMove(page, 'backward', 400);

    // Verify we're still alive and connected
    const final = await snapshot(page);
    expect(final.dead).toBe(false);
    expect(final.mode).toBe('practice');

    // Turn off debug overlay
    await toggleDebugOverlay(page);
    const snap2 = await snapshot(page);
    expect(snap2.debugOverlayVisible).toBe(false);
  });
});
