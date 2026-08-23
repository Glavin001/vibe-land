/**
 * The city destruction invariants on WIRE V3 — LiveEncoder debris spans
 * decoded by the wasm module in a real browser.
 *
 * The pose path underneath is entirely different from v2 (span datagrams +
 * reliable lane assignments instead of ranked per-client records + baselines),
 * which is exactly why the assertions must not change: the wires are
 * interchangeable or they are not.
 *
 * Run with the stack's server started under VIBE_CITY_WIRE=3:
 *   E2E_CITY=1 E2E_CITY_WIRE=3 npx playwright test --config e2e/playwright.config.ts city-destruction-v3
 */
import { expect, test } from '@playwright/test';

import {
  cityStats,
  fireAt,
  openCity,
  sampleCity,
  tallestStructureTarget,
  waitForCityRendered,
  waitUntilStill,
} from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1' && process.env.E2E_CITY_WIRE === '3';

test.describe('city destruction over wire v3', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 E2E_CITY_WIRE=3 (server under VIBE_CITY_WIRE=3)');

  test('renders, fractures and settles with a gapless ledger', async ({ page }) => {
    test.setTimeout(180_000);
    await openCity(page);
    await waitForCityRendered(page);

    const before = await cityStats(page);
    // The whole point: prove which wire actually ran.
    expect(before.wireVersion).toBe(3);
    expect(before.chunksTotal).toBeGreaterThan(1000);
    expect(before.topoSeqGaps).toBe(0);

    // 0.35, not the helper's 0.6 default: on the tallest tower that aim point
    // sits ~102 m from the spawn, past the weapon's reach, so whether anything
    // broke depended on where the player happened to spawn. A spec that only
    // sometimes fires is worse than no spec -- this one's job is to notice when
    // destruction stops reaching the client, and it missed a wire-version
    // regression that did exactly that.
    const target = await tallestStructureTarget(page, 0.35);
    await fireAt(page, target, 24);
    await waitUntilStill(page, { timeout: 30_000 });

    const samples = await sampleCity(page, 3);
    const after = samples[samples.length - 1];
    expect(after.brokenBonds).toBeGreaterThan(before.brokenBonds);
    expect(after.liveIslands).toBeGreaterThan(0);
    expect(after.topoSeqGaps).toBe(0);
    expect(after.orphanedChunks).toBe(0);
    expect(after.datagramsReceived).toBeGreaterThan(0);
  });
});
