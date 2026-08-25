/**
 * Client frame budget, measured rather than screenshotted.
 *
 * This exists because every perf claim about the /city page so far has come
 * from reading a number off a panel in a screenshot, one sample at a time. The
 * bridge now exposes the same per-phase breakdown the panel shows, so a run
 * can report the distribution under a real demolition and a change can be
 * judged against the run before it.
 *
 * Reports, and asserts only the structural invariants (the phases account for
 * the frame; the renderer is not the bottleneck). Absolute budgets belong to
 * the machine running it, not to the code.
 *
 *   E2E_CITY=1 E2E_CITY_WIRE=3 E2E_SKIP_WEB_SERVER=1 \
 *   E2E_BASE_URL=https://127.0.0.1:6006 \
 *   npx playwright test --config e2e/playwright.config.ts city-frame-profile
 */
import { expect, test } from '@playwright/test';

import {
  allStructureTargets,
  cityStats,
  fireAt,
  openCity,
  waitForCityRendered,
} from '../helpers/city';

const ENABLED = process.env.E2E_CITY === '1';

type Profile = Record<string, number>;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** Sample the bridge's frame profile once per animation frame. */
async function sampleProfiles(page: import('@playwright/test').Page, frames: number): Promise<Profile[]> {
  return page.evaluate(async (count) => {
    const bridge = (window as unknown as {
      __VIBE_E2E__?: { frameProfile?: () => Record<string, number> };
    }).__VIBE_E2E__;
    if (!bridge?.frameProfile) throw new Error('bridge has no frameProfile');
    const out: Record<string, number>[] = [];
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        out.push(bridge.frameProfile!());
        if (out.length >= count) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return out;
  }, frames);
}

function summarize(label: string, profiles: Profile[]): Profile {
  const keys = [
    'frameTotalMs', 'cpuFrameMs', 'offFrameMs', 'unattributedMs',
    'glRenderMs', 'beforeCityMs', 'cityFrameMs',
    'sampleMs', 'dirtyWriteMs', 'sphereMs', 'telemetryMs', 'debugE2eMs', 'decodeMs',
    'instanceWrites', 'drawCalls', 'triangles',
  ];
  const p95: Profile = {};
  const lines: string[] = [];
  for (const key of keys) {
    const values = profiles.map((p) => p[key] ?? 0);
    p95[key] = percentile(values, 0.95);
    const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    lines.push(`  ${key.padEnd(16)} avg ${avg.toFixed(2).padStart(9)}  p95 ${p95[key].toFixed(2).padStart(9)}`);
  }
  console.log(`\n[frame profile] ${label} (${profiles.length} frames)\n${lines.join('\n')}`);
  return p95;
}

test.describe('city client frame budget', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1 (server must be running)');

  test('accounts for the frame, at rest and under demolition', async ({ page }) => {
    test.setTimeout(240_000);
    await openCity(page);
    await waitForCityRendered(page);

    const atRest = summarize('at rest', await sampleProfiles(page, 120));

    // Bring several towers down: the load case is thousands of live bodies
    // being recomposed, not an intact city.
    const targets = await allStructureTargets(page);
    for (const target of targets.slice(0, 4)) {
      await fireAt(page, target, 12);
    }
    const during = summarize('under demolition', await sampleProfiles(page, 180));
    const stats = await cityStats(page);
    console.log(`[frame profile] awake=${stats.chunksAwake} settled=${stats.chunksSettled} `
      + `bonds=${stats.brokenBonds} islands=${stats.liveIslands}`);

    for (const [label, p95] of [['at rest', atRest], ['under demolition', during]] as const) {
      // The phases must account for the frame. A large remainder means a
      // bracket is missing, which is the failure this suite exists to catch --
      // it is how the "28 ms unattributed" state went unexplained for a week.
      expect(p95.unattributedMs, `${label}: unbracketed main-thread time`).toBeLessThan(6);
      // And the renderer must not be the story: if gl.render ever dominates
      // cpuFrame, the bottleneck moved to the GPU/upload path and the whole
      // worker-offload premise needs re-checking.
      expect(p95.glRenderMs, `${label}: gl.render vs cpu frame`)
        .toBeLessThan(Math.max(4, p95.cpuFrameMs));
    }
  });
});
