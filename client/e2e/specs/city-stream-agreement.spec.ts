/**
 * Stream-agreement gate (P5): after a scripted join + bombardment the client's
 * ledger must AGREE with the server — bond delta exactly 0 — having spent at
 * most one repair (targeted structure bootstrap or full re-bootstrap) beyond
 * the join, with the hash detector demonstrably running (hashChecks > 0).
 *
 * Exists because a session panel once showed 9-50 bootstraps, a 1294-bond
 * client/server delta and 64 client-only bodies below ground while
 * `city_desync_repairs` sat at 0: the stream was undetectably lossy and the
 * only repair was a full-world rebuild. This spec is the regression floor for
 * the detection+targeted-repair path.
 *
 * Run with the stack's server started:
 *   E2E_CITY=1 npx playwright test --config e2e/playwright.config.ts city-stream-agreement
 */
import { expect, test } from '@playwright/test';

import {
  cityStats,
  fireAt,
  openCity,
  tallestStructureTarget,
  waitForCityRendered,
  waitUntilStill,
} from '../helpers/city';
import { waitForSnapshot } from '../helpers/toolkit';

const ENABLED = process.env.E2E_CITY === '1';

/** Server-side broken-bond count, read through the page's own origin. */
async function serverBrokenBonds(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch('/match-stats/city-default');
    if (!response.ok) throw new Error(`match-stats fetch failed: ${response.status}`);
    const stats = await response.json();
    return stats.city.broken_bonds as number;
  });
}

test.describe('city stream agreement', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  test('bombardment ends at bond delta 0 with at most one repair', async ({ page }) => {
    test.setTimeout(240_000);
    await openCity(page);
    await waitForCityRendered(page);

    const before = await cityStats(page);
    expect(before.topoSeqGaps).toBe(0);
    const joinBootstraps = before.bootstraps;

    // Same aim discipline as city-destruction-v3: 0.35 keeps the target
    // inside weapon reach from any spawn, so the bombardment always lands.
    const target = await tallestStructureTarget(page, 0.35);
    await fireAt(page, target, 24);
    await waitUntilStill(page, { timeout: 60_000 });

    // Give the detector time to run seq-aligned: hashes broadcast every 2 s
    // and only compare in quiet periods, which the stillness above provides.
    await waitForSnapshot(page, (s) => !!s.city && s.city.hashChecks >= 3, {
      timeout: 30_000,
    });

    // Agreement, allowing the stream one in-flight beat: re-read once if the
    // first comparison catches a tick between the two sides' counters.
    let client = (await cityStats(page)).brokenBonds;
    let server = await serverBrokenBonds(page);
    if (client !== server) {
      await page.waitForTimeout(3000);
      client = (await cityStats(page)).brokenBonds;
      server = await serverBrokenBonds(page);
    }
    expect(server).toBeGreaterThan(0); // the bombardment must actually land
    expect(client, `bond delta ${client - server} after a settled bombardment`).toBe(server);

    const after = await cityStats(page);
    const repairsBeyondJoin = after.bootstraps - joinBootstraps + after.structureRepairs;
    expect(
      repairsBeyondJoin,
      `repairs beyond join: ${after.bootstraps - joinBootstraps} full + ${after.structureRepairs} targeted`,
    ).toBeLessThanOrEqual(1);
    expect(after.hashChecks).toBeGreaterThan(0);
    expect(after.topoSeqGaps).toBe(0);
  });
});
