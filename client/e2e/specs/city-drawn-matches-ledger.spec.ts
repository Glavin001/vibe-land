/**
 * The invariant that a fracture must not break: every chunk is DRAWN where the
 * ledger says it is.
 *
 * This is the class of bug that produced "the building opens into a hole and
 * the pieces appear a moment later" -- chunks composed against a body they had
 * already left, and drawn hundreds of metres from their real position. Nothing
 * in the aggregate counters can see it: triangle count, draw calls, awake
 * bodies and topology gaps are all unchanged when geometry is merely in the
 * WRONG PLACE. Only comparing the drawn transform against the ledger can.
 *
 * `staleDrawnChunks` (netlab recorder) is that comparison: per slot, last
 * position written into the BatchedMesh versus the ledger's composed pose. It
 * is sampled through the fracture transition, which is the only moment the
 * regression appeared.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-drawn-matches-ledger
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

/**
 * Anomalous single-frame chunk jumps recorded since recording started.
 *
 * The 2 Hz `staleDrawnChunks` counter compares each slot's LAST drawn position
 * against the ledger, so a chunk that is mis-drawn for two frames and then
 * corrected is invisible to it -- the wrong value has been overwritten long
 * before the sample. The teleport probe runs on every write instead, and
 * judges each step against that chunk's own recent speed, so a body composed
 * against the wrong basis registers as a jump its trajectory cannot explain.
 * That is the detector a transient mis-compose needs.
 */
async function teleportEvents(page: import('@playwright/test').Page): Promise<
  Array<{ slot: number; stepM: number; body: number; source: string }>
> {
  return page.evaluate(() => {
    const recorder = (window as unknown as {
      __VIBE_RECORDER__: {
        drainEvents: (fromSeq: number, max: number) => { events: Array<Record<string, unknown>> };
      };
    }).__VIBE_RECORDER__;
    const drained = recorder.drainEvents(0, 5000);
    return drained.events
      .filter((e) => e.name === 'city_chunk_teleport' || e.kind === 'city_chunk_teleport')
      .map((e) => {
        const data = (e.data ?? e) as Record<string, number | string>;
        return {
          slot: Number(data.slot ?? -1),
          stepM: Number(data.stepM ?? 0),
          body: Number(data.body ?? -1),
          source: String(data.source ?? '?'),
        };
      });
  });
}

test.describe('drawn chunks match the ledger', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  test('through a fracture, no chunk is drawn away from its ledger pose', async ({ page }) => {
    test.setTimeout(240_000);
    await openCity(page);
    await waitForCityRendered(page);

    // The probe only exists while recording: it costs a compare and three
    // stores per chunk write, which is why it is not always on.
    await page.evaluate(() => {
      (window as unknown as {
        __VIBE_RECORDER__: { start: (o?: unknown) => void };
      }).__VIBE_RECORDER__.start({ maxFrames: 4000, maxEvents: 4000 });
    });
    // One telemetry cycle so the probe has a baseline for every slot.
    await page.waitForTimeout(1200);

    const intact = await page.evaluate(
      () => (window as unknown as {
        __VIBE_E2E__: { snapshot: () => { city?: { staleDrawnChunks?: number } } };
      }).__VIBE_E2E__.snapshot().city?.staleDrawnChunks ?? -1,
    );
    expect(intact, 'probe not reporting (is recording on?)').toBeGreaterThanOrEqual(0);
    expect(intact, 'chunks already mis-drawn before firing').toBeLessThanOrEqual(2);

    // Sample straight through the fracture: the regression lived in the
    // transition from intact to fractured, not in either steady state.
    const target = await tallestStructureTarget(page, 0.35);
    await fireAt(page, target, 8);
    await page.waitForTimeout(3000);

    const jumps = await teleportEvents(page);
    const settled = await page.evaluate(
      () => (window as unknown as {
        __VIBE_E2E__: { snapshot: () => { city?: { staleDrawnChunks?: number } } };
      }).__VIBE_E2E__.snapshot().city?.staleDrawnChunks ?? -1,
    );
    const stats = await cityStats(page);
    const biggest = jumps.reduce((max, j) => Math.max(max, j.stepM), 0);
    console.log(`[drawn] intact=${intact} settled=${settled} teleports=${jumps.length} `
      + `biggestStepM=${biggest.toFixed(1)} bonds=${stats.brokenBonds} islands=${stats.liveIslands}`);
    for (const jump of jumps.slice(0, 8)) {
      console.log(`[drawn]   slot=${jump.slot} step=${jump.stepM.toFixed(1)}m `
        + `body=${jump.body} source=${jump.source}`);
    }

    // A mis-composed chunk moves by the distance between two bodies -- tens to
    // hundreds of metres. Debris genuinely flies, so the probe already judges
    // each step against the chunk's own speed; what is left should be nothing.
    expect(biggest, 'a chunk jumped further than its own motion can explain')
      .toBeLessThan(25);
    expect(settled, 'chunks left mis-drawn after everything settled').toBeLessThanOrEqual(2);
  });
});
