/**
 * Sustained-fire soak.
 *
 * A city that loads and pans fine but dies after enough shooting is not a
 * footprint problem, it is an accumulation problem. This walks the city
 * shooting every structure in turn and samples the JS heap and the server's
 * live-body counts between rounds.
 *
 * What this found the first time: the JS heap does not leak (flat at 92 MB
 * through 336 shots, one step to 386 MB after that and flat again) -- the
 * accumulation is server-side. Rubble settles far more slowly than it should:
 * ~10,000 of 56,583 chunks stayed permanently awake, and the server's own
 * `resettled_wakes` counter kept climbing with no shots fired, meaning settled
 * piles were re-waking themselves. That is a bigger tick and a bigger transform
 * stream forever, which a desktop's larger memory ceiling and headroom absorb
 * and a phone does not. Re-run this after any change to the settle/freeze path
 * to see whether `awake` actually comes back down once fire stops.
 *
 * Gated behind E2E_CITY=1 like the rest of the city suite.
 */
import { test } from '@playwright/test';

import { join, snapshot } from '../helpers/toolkit';
import {
  fireAt,
  openCity,
  waitForCityRendered,
  walkToward,
} from '../helpers/city';

const CITY_ENABLED = process.env.E2E_CITY === '1';
const STAND_OFF_M = 11;

/**
 * Where the buildings actually are, from `structures/neighbourhood.mjs`.
 *
 * NOT `allStructureTargets`: the skyline is one merged structure, so that
 * returns a single centre for a cluster 200 m across, which is open ground
 * between the towers. Firing there routes shots the server logs as `hits=0`
 * and the soak measures nothing. Each entry is aimed at material, part-way up.
 */
const BUILDINGS: Array<[number, number, number]> = [
  [0, 25, -96],   // Petronas
  [-72, 25, 8],   // 432 Park
  [4, 12, 16],    // Algedra
  [74, 5, 12],    // parking garage
  [-42, 5, 74],   // Villa Savoye
  [2, 3, 76],     // house, one storey
  [34, 4, 74],    // house, two storeys
];
const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 12);
const SHOTS_PER_TARGET = Number(process.env.SOAK_SHOTS ?? 10);

test.describe('city shoot soak', () => {
  test.skip(!CITY_ENABLED, 'set E2E_CITY=1 to run the soak');

  test('sustained fire does not grow the client without bound', async ({ page }) => {
    test.setTimeout(30 * 60_000);

    await openCity(page);
    await join(page);
    await waitForCityRendered(page);

    const sample = async () => page.evaluate(() => {
      const s = (window as any).__VIBE_E2E__.snapshot();
      const m = (performance as any).memory;
      return {
        heap: m ? Math.round(m.usedJSHeapSize / 1e6) : 0,
        awake: s.city?.chunksAwake ?? 0,
        settled: s.city?.chunksSettled ?? 0,
        broken: s.city?.brokenBonds ?? 0,
        islands: s.city?.liveIslands ?? 0,
        below: s.city?.chunksBelowGround ?? 0,
      };
    });

    const targets = BUILDINGS;
    // eslint-disable-next-line no-console
    console.log(`SOAK targets=${targets.length}`);
    // eslint-disable-next-line no-console
    console.log('round  shots  heap MB  awake  settled  broken  islands  below');
    let shots = 0;
    const first = await sample();
    // eslint-disable-next-line no-console
    console.log(`    0      0  ${String(first.heap).padStart(7)}  ${String(first.awake).padStart(5)}` +
      `  ${String(first.settled).padStart(7)}  ${String(first.broken).padStart(6)}` +
      `  ${String(first.islands).padStart(7)}  ${String(first.below).padStart(5)}`);

    for (let round = 1; round <= ROUNDS; round += 1) {
      for (const target of targets) {
        await walkToward(page, target, STAND_OFF_M, { maxSteps: 40 });
        await fireAt(page, target, SHOTS_PER_TARGET, { intervalMs: 140 });
        shots += SHOTS_PER_TARGET;
      }
      await page.waitForTimeout(2500);
      const s = await sample();
      const pos = (await snapshot(page)).position;
      // eslint-disable-next-line no-console
      console.log(`${String(round).padStart(5)}  ${String(shots).padStart(5)}  ${String(s.heap).padStart(7)}` +
        `  ${String(s.awake).padStart(5)}  ${String(s.settled).padStart(7)}  ${String(s.broken).padStart(6)}` +
        `  ${String(s.islands).padStart(7)}  ${String(s.below).padStart(5)}` +
        `   at ${pos.map((n: number) => n.toFixed(0)).join(',')}`);
    }
  });
});
