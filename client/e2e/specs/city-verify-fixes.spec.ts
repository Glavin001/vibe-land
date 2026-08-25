/**
 * End-to-end confirmation of the two live fixes, on a real GPU.
 *
 * 1. The client ledger tracks the server's destruction -- across a city reset,
 *    which is the case that silently downgraded the wire and left the city
 *    looking indestructible.
 * 2. Firing does not flash chunks white: "unknown to server" must not fire on
 *    the body-state poll's own latency.
 *
 * Run headed with the GPU args the config already carries:
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-verify-fixes --headed
 */
import { expect, test } from '@playwright/test';

import {
  cityStats,
  fireAt,
  openCity,
  tallestStructureTarget,
  waitForCityRendered,
} from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1';
const STATS_URL = process.env.E2E_STATS_URL ?? 'http://127.0.0.1:4003';

async function serverBrokenBonds(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const response = await request.get(`${STATS_URL}/match-stats/city-default`);
  const json = await response.json();
  return json.city?.broken_bonds ?? -1;
}

test.describe('city fixes', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  test('destruction reaches the client, and shooting never flashes white', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);

    // Reset first: this is the exact path that used to drop the v3 encoder and
    // put the server back on v2 while the client stayed on v3.
    await request.post(`${STATS_URL}/city-reset/city-default`);
    await page.waitForTimeout(8000);

    await openCity(page);
    await waitForCityRendered(page);
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    console.log(`[verify] renderer: ${gpu}`);

    // Body colours ON: the white flash only exists in this mode, so this is
    // the configuration that has to be checked.
    await page.getByTestId('city-body-colors').click();
    await page.waitForTimeout(1200);

    const target = await tallestStructureTarget(page, 0.35);

    // Screenshots straight through the impact: the white flash lasted up to a
    // second (the body-state poll interval), so a burst across that window
    // catches it if it is still there. Judged by eye -- it is a colour on
    // screen, and no counter can stand in for that.
    const before = await cityStats(page);
    await fireAt(page, target, 3);
    for (let i = 0; i < 6; i += 1) {
      await page.screenshot({ path: `e2e/test-results/impact-${i}.png` });
      await page.waitForTimeout(180);
    }
    await fireAt(page, target, 13);
    await page.waitForTimeout(3000);

    const after = await cityStats(page);
    const serverBonds = await serverBrokenBonds(request);
    console.log(
      `[verify] client bonds ${before.brokenBonds} -> ${after.brokenBonds}, `
        + `server ${serverBonds}, islands ${after.liveIslands}, `
        + `datagrams ${after.datagramsReceived}, gaps ${after.topoSeqGaps}`,
    );

    // The fix: the ledger must actually track the server, not sit at zero.
    expect(after.brokenBonds, 'client saw no destruction').toBeGreaterThan(before.brokenBonds);
    expect(after.datagramsReceived, 'no debris datagrams reached the client').toBeGreaterThan(0);
    expect(after.topoSeqGaps).toBe(0);
    expect(after.orphanedChunks).toBe(0);
    // Within a few percent of the server: the client is a tick or two behind,
    // not a world behind.
    expect(Math.abs(after.brokenBonds - serverBonds)).toBeLessThan(
      Math.max(50, serverBonds * 0.1),
    );
  });
});
