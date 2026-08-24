/**
 * A fracture must be visually continuous.
 *
 * First principles: when the server splits a body it has not moved anything --
 * no time has passed and no physics has run. The chunks that become a new
 * island are, at that instant, exactly where they were as part of the parent.
 * So no chunk may jump at the fracture frame, and none may pass under the
 * world (which is what the renderer culls on, and therefore the only way a
 * chunk can vanish).
 *
 * This measures both, per frame, with no thresholds or heuristics: the whole
 * ledger is composed every frame and compared with the previous frame. It
 * exists because the reported symptom -- a building showing its post-fracture
 * cutout a frame or two before the fractured pieces appear -- is far shorter
 * than a screenshot, and invisible to every aggregate counter.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-fracture-continuity
 */
import { expect, test } from '@playwright/test';

import {
  aimAt,
  cityStats,
  fireAt,
  openCity,
  tallestStructureTarget,
  waitForCityRendered,
} from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1';

interface FrameSample {
  t: number;
  maxJump: number;
  jumpSlot: number;
  jumpers: number;
  belowWorld: number;
  minY: number;
  hidden: number;
  writes: number;
  tri: number;
}

test.describe('fracture continuity', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  test('no chunk jumps or leaves the world when a body fractures', async ({ page }) => {
    test.setTimeout(240_000);
    await openCity(page);
    await waitForCityRendered(page);
    // The probe reads composed poses through the recorder's debug handle.
    await page.evaluate(() => {
      (window as unknown as { __VIBE_RECORDER__: { start: (o?: unknown) => void } })
        .__VIBE_RECORDER__.start({ maxFrames: 4000, maxEvents: 4000 });
    });
    await page.waitForTimeout(1200);

    const target = await tallestStructureTarget(page, 0.35);
    await aimAt(page, target);
    await page.waitForTimeout(800);

    // Watch every frame across the shot. Positions are diffed in-page so only
    // per-frame summaries cross the bridge.
    await page.evaluate(() => {
      const debug = (window as unknown as {
        __VIBE_CITY_DEBUG__: { snapshotLedger: () => number[] };
      }).__VIBE_CITY_DEBUG__;
      const samples: unknown[] = [];
      (window as unknown as { __CONT__: unknown[] }).__CONT__ = samples;
      let previous: number[] | null = null;
      const tick = (): void => {
        const now = debug.snapshotLedger();
        if (previous && previous.length === now.length) {
          let maxJump = 0;
          let jumpSlot = -1;
          let jumpers = 0;
          let belowWorld = 0;
          let minY = Infinity;
          for (let i = 0; i < now.length; i += 3) {
            const d = Math.hypot(
              now[i] - previous[i],
              now[i + 1] - previous[i + 1],
              now[i + 2] - previous[i + 2],
            );
            if (d > maxJump) { maxJump = d; jumpSlot = i / 3; }
            // 0.5 m in one frame is 30 m/s; debris does that, an intact
            // building at the instant of its own fracture does not.
            if (d > 0.5) jumpers += 1;
            if (now[i + 1] < -4) belowWorld += 1;
            if (now[i + 1] < minY) minY = now[i + 1];
          }
          const profile = (window as unknown as {
            __VIBE_E2E__: { frameProfile: () => Record<string, number> };
          }).__VIBE_E2E__.frameProfile();
          samples.push({
            t: Math.round(performance.now()), maxJump, jumpSlot, jumpers, belowWorld, minY,
            // The only per-instance visibility control there is: if geometry
            // disappears, this is what did it.
            hidden: profile.chunksHidden, writes: profile.instanceWrites,
            tri: profile.triangles,
          });
        }
        previous = now;
        if (samples.length < 240) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.waitForTimeout(400);
    await fireAt(page, target, 1);
    await page.waitForTimeout(3000);

    const samples = (await page.evaluate(
      () => (window as unknown as { __CONT__: FrameSample[] }).__CONT__,
    )) as FrameSample[];
    const stats = await cityStats(page);

    const worstJump = samples.reduce((a, b) => (b.maxJump > a.maxJump ? b : a), samples[0]);
    const worstBelow = samples.reduce((a, b) => (b.belowWorld > a.belowWorld ? b : a), samples[0]);
    console.log(`[cont] frames=${samples.length} bonds=${stats.brokenBonds} islands=${stats.liveIslands}`);
    console.log(`[cont] worst jump ${worstJump.maxJump.toFixed(2)} m (slot ${worstJump.jumpSlot}, `
      + `${worstJump.jumpers} chunks over 0.5 m)`);
    console.log(`[cont] worst below-world ${worstBelow.belowWorld} chunks, minY ${worstBelow.minY.toFixed(1)} m`);
    const hiddenDelta = samples[samples.length - 1].hidden - samples[0].hidden;
    const minTri = samples.reduce((m, s) => Math.min(m, s.tri), Infinity);
    const maxTri = samples.reduce((m, s) => Math.max(m, s.tri), 0);
    console.log(`[cont] chunks hidden during the window: ${hiddenDelta}`);
    console.log(`[cont] triangles ${minTri}..${maxTri} (a dip means geometry left the draw)`);
    for (const s of samples.filter((x) => x.belowWorld > 0 || x.jumpers > 0).slice(0, 10)) {
      console.log(`[cont]   t=${s.t} maxJump=${s.maxJump.toFixed(2)} jumpers=${s.jumpers} `
        + `below=${s.belowWorld} minY=${s.minY.toFixed(1)}`);
    }

    expect(stats.brokenBonds, 'the shot broke nothing, so nothing was measured')
      .toBeGreaterThan(0);
    // A chunk that passes under the world gets culled -- that is the hole.
    expect(worstBelow.belowWorld, 'chunks passed under the world and were culled')
      .toBe(0);
    // Nothing may be culled by the fracture itself.
    expect(samples[samples.length - 1].hidden - samples[0].hidden,
      'the under-world cull fired during a fracture').toBe(0);
  });
});
