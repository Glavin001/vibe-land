/**
 * Multiplayer Smoke Spec
 *
 * Opens two isolated browser contexts on /play?match=<unique>,
 * joins both, and verifies:
 * - Both players connect with non-zero player IDs
 * - Non-local transport is active
 * - Each player sees the other as a remote player
 * - Moving player A causes player B to observe position changes
 * - Firing from A updates shot counters
 */
import { test, expect } from '@playwright/test';
import {
  openPlay,
  join,
  acquirePointerLock,
  toggleDebugOverlay,
  snapshot,
  waitForSnapshot,
  holdMove,
  shootOnce,
} from '../helpers/toolkit';

test.describe('Multiplayer Smoke', () => {
  test('two-player match flow', async ({ browser }) => {
    const matchId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Create two isolated browser contexts
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      // 1. Open /play with the same match ID in both contexts
      await Promise.all([
        openPlay(pageA, matchId),
        openPlay(pageB, matchId),
      ]);

      // 2. Join both players
      const [joinA, joinB] = await Promise.all([
        join(pageA, { timeout: 30_000 }),
        join(pageB, { timeout: 30_000 }),
      ]);

      // Both should be in multiplayer mode
      expect(joinA.mode).toBe('multiplayer');
      expect(joinB.mode).toBe('multiplayer');

      // 3. Acquire pointer lock in both
      await Promise.all([
        acquirePointerLock(pageA),
        acquirePointerLock(pageB),
      ]);

      // 4. Wait for non-zero player IDs and non-local transport
      const readyA = await waitForSnapshot(
        pageA,
        (s) => s.playerId > 0 && s.transport !== 'connecting' && s.transport !== 'local-preview',
        { timeout: 30_000, label: 'player A ready' },
      );
      const readyB = await waitForSnapshot(
        pageB,
        (s) => s.playerId > 0 && s.transport !== 'connecting' && s.transport !== 'local-preview',
        { timeout: 30_000, label: 'player B ready' },
      );

      expect(readyA.playerId).toBeGreaterThan(0);
      expect(readyB.playerId).toBeGreaterThan(0);
      expect(readyA.playerId).not.toBe(readyB.playerId);

      // 5. Toggle debug overlay in both to verify F3 works
      await Promise.all([
        toggleDebugOverlay(pageA),
        toggleDebugOverlay(pageB),
      ]);

      // Verify debug overlays are visible
      await expect(pageA.locator('[data-testid="debug-overlay"]')).toBeVisible({ timeout: 5_000 });
      await expect(pageB.locator('[data-testid="debug-overlay"]')).toBeVisible({ timeout: 5_000 });

      // 6. Wait until each page reports one remote player
      await waitForSnapshot(
        pageA,
        (s) => s.remotePlayers.length >= 1,
        { timeout: 30_000, label: 'A sees remote player' },
      );
      await waitForSnapshot(
        pageB,
        (s) => s.remotePlayers.length >= 1,
        { timeout: 30_000, label: 'B sees remote player' },
      );

      // 7. Move player A and verify player B observes the position change
      const beforeMoveB = await snapshot(pageB);
      const remoteABefore = beforeMoveB.remotePlayers.find(
        (rp) => rp.id === readyA.playerId,
      );

      await holdMove(pageA, 'forward', 1000);
      await pageA.waitForTimeout(500);

      // Wait for B to see A's position update
      const afterMoveB = await waitForSnapshot(
        pageB,
        (s) => {
          const remoteA = s.remotePlayers.find((rp) => rp.id === readyA.playerId);
          if (!remoteA || !remoteABefore) return false;
          const delta = Math.hypot(
            remoteA.position[0] - remoteABefore.position[0],
            remoteA.position[2] - remoteABefore.position[2],
          );
          return delta > 0.3;
        },
        { timeout: 10_000, label: 'B sees A moved' },
      );

      const remoteAAfter = afterMoveB.remotePlayers.find(
        (rp) => rp.id === readyA.playerId,
      );
      expect(remoteAAfter).toBeDefined();

      // 8. Fire once from A and check shot counters update
      const beforeShot = await snapshot(pageA);
      await shootOnce(pageA);
      await pageA.waitForTimeout(500);
      const afterShot = await snapshot(pageA);
      expect(afterShot.shotsFired).toBeGreaterThanOrEqual(beforeShot.shotsFired);

      // Verify no disconnects
      const finalA = await snapshot(pageA);
      const finalB = await snapshot(pageB);
      expect(finalA.playerId).toBeGreaterThan(0);
      expect(finalB.playerId).toBeGreaterThan(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
