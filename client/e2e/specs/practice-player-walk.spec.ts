import { expect, test } from '@playwright/test';
import {
  acquirePointerLock,
  holdMove,
  join,
  openPractice,
  snapshot,
  waitForSnapshot,
} from '../helpers/toolkit';

/**
 * Regression suite for the player capsule (KCC) path through destructibles.
 *
 * The E2E destructibles test only exercises vehicle-vs-wall impact.  The KCC
 * uses Rapier's `KinematicCharacterController` with shape-casts instead of
 * the rigid-body collision pipeline that vehicles use, so a bug in one path
 * can be invisible to tests covering the other.
 *
 * What these tests cover:
 * - Player on foot is physically blocked by the practice wall
 * - No fracture events occur from player walking contact alone
 * - All chunks remain above the ground plane after the player interaction
 * - Spatial metrics stay healthy when no impact stress has been applied
 */
test.describe('Practice Player Walk', () => {
  test('player on foot is blocked by the practice wall and does not phase through', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'sim ready' },
    );

    const initial = await snapshot(page);
    expect(initial.inVehicle).toBe(false);
    expect(initial.destructibles.chunkCount).toBeGreaterThan(0);
    expect(initial.destructibles.debugConfig.debrisCollisionMode).toBe('all');

    // Verify no fractures yet
    expect(initial.destructibles.fractureEventsTotal).toBe(0);

    // Walk forward toward the wall at z=8 for long enough to reach it even in CI
    // (WasmLocalSession physics runs via MessageChannel at 60 Hz independent of rAF).
    const before = await snapshot(page);
    await holdMove(page, 'forward', 4_000);
    const after = await snapshot(page);

    // Player must have moved forward at all
    expect(after.cameraPosition[2]).toBeGreaterThan(before.cameraPosition[2] + 0.5);

    // Wall front face at z≈7.84 minus capsule radius ≈0.4 → stops around z≤7.5.
    // The player must NOT pass through the wall.
    expect(after.cameraPosition[2]).toBeLessThan(7.8);

    // Walking into a wall must not trigger fracture events
    expect(after.destructibles.fractureEventsTotal).toBe(0);

    // All chunks must remain above the ground plane
    expect(after.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-0.1);
    expect(after.destructibles.spatialMetrics.significantOverlapPairCount).toBe(0);
  });

  test('spatial metrics are healthy before any impact', async ({ page }) => {
    await openPractice(page);
    await join(page);
    await acquirePointerLock(page);

    const ready = await waitForSnapshot(
      page,
      (s) => s.transport === 'local-preview' || s.transport === 'local',
      { timeout: 15_000, label: 'sim ready' },
    );

    // Both wall (id=2000) and tower (id=2001) contribute chunks.
    // A wall alone has ~18 chunks; tower has more — combined must exceed 18.
    expect(ready.destructibles.chunkCount).toBeGreaterThan(18);

    // No pre-impact overlap of any kind
    expect(ready.destructibles.spatialMetrics.significantOverlapPairCount).toBe(0);
    expect(ready.destructibles.spatialMetrics.nearCoincidentPairCount).toBe(0);
    expect(ready.destructibles.spatialMetrics.maxOverlapPenetrationM).toBeLessThan(0.05);
    expect(ready.destructibles.spatialMetrics.lowestChunkBottomY).toBeGreaterThan(-0.05);

    // No fracture or contact events at spawn time
    expect(ready.destructibles.fractureEventsTotal).toBe(0);
    expect(ready.destructibles.debugState.contactEventsAcceptedTotal).toBe(0);
  });
});
