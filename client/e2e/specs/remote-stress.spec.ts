/**
 * Stress a *remote* game server and report whether its box is the right size.
 *
 * Every perf number for a rented box so far has come from reading a panel off
 * a screenshot, on whatever machine happened to have the tab open. This drives
 * a scripted demolition against a box by URL and records both halves at once:
 * the client frame profile (via `__VIBE_E2E__`) and the server's own physics
 * timings (via `/match-stats/:id`), sampled once a second throughout.
 *
 * The server half is the one that answers "is this enough GPU". Vast gives no
 * shell on an `args`-runtype box and reports `gpu_util: null` over its API, so
 * nvidia-smi is not available -- but `physics_gpu_wait_ms` is strictly better
 * for this question anyway: it is the milliseconds of each tick spent blocked
 * on the device, which is what actually decides whether the box keeps 60 Hz.
 *
 *   E2E_STRESS=1 \
 *   E2E_BASE_URL=https://<ip>:<web-port> \
 *   E2E_CITY_WT_URL=off \
 *   E2E_SKIP_WEB_SERVER=1 \
 *   npx playwright test --config e2e/playwright.config.ts remote-stress
 *
 * `E2E_CITY_WT_URL=off` is load-bearing: the default rewrites session-config to
 * 127.0.0.1:4434 for a local stack, which would point this run at nothing.
 */
import { expect, request, test } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import {
  allStructureTargets,
  cityStats,
  fireAt,
  openCity,
  waitForCityRendered,
} from '../helpers/city';

const ENABLED = process.env.E2E_STRESS === '1';
const LABEL = process.env.E2E_STRESS_LABEL ?? 'remote';
const MATCH_ID = process.env.E2E_STRESS_MATCH ?? 'city-default';
/** How many structures to bring down, and how many rounds into each. */
const TARGETS = Number(process.env.E2E_STRESS_TARGETS ?? 6);
const SHOTS = Number(process.env.E2E_STRESS_SHOTS ?? 14);

type Sample = Record<string, number>;

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function stat(values: number[]): { avg: number; p50: number; p95: number; max: number } {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  return {
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

/**
 * Poll `/match-stats/:id` once a second until stopped.
 *
 * Uses Playwright's request context rather than node fetch so the self-signed
 * certificate the entrypoint mints per boot is accepted the same way the
 * browser accepts it -- no NODE_TLS_REJECT_UNAUTHORIZED, which would disable
 * verification for everything else in the process too.
 */
function startServerPoll(baseUrl: string): {
  stop: () => Promise<Sample[]>;
  errors: string[];
} {
  const samples: Sample[] = [];
  const errors: string[] = [];
  let running = true;
  const loop = (async () => {
    const ctx = await request.newContext({ ignoreHTTPSErrors: true });
    while (running) {
      try {
        const res = await ctx.get(`${baseUrl}/match-stats/${MATCH_ID}`, { timeout: 5_000 });
        if (res.ok()) {
          const body = await res.json();
          samples.push({
            t: Date.now(),
            stepMs: body.physics_last_step_ms ?? 0,
            simulateMs: body.physics_simulate_ms ?? 0,
            fetchMs: body.physics_fetch_ms ?? 0,
            gpuWaitMs: body.physics_gpu_wait_ms ?? 0,
            fetchCopyMs: body.physics_fetch_copy_ms ?? 0,
            controllerMs: body.physics_controller_ms ?? 0,
            activeBodies: body.physics_active_dynamic_bodies ?? 0,
            contactPairs: body.physics_contact_pairs ?? 0,
            dynamicBodies: body.dynamic_body_count ?? 0,
            chunkCount: body.chunk_count ?? 0,
            players: body.player_count ?? 0,
            gpuActive: body.physics_gpu_active ? 1 : 0,
            gpuWarnings: body.physics_gpu_warning_count ?? 0,
            serverTick: body.server_tick ?? 0,
          });
        } else if (res.status() !== 404) {
          errors.push(`match-stats ${res.status()}`);
        }
      } catch (error) {
        errors.push(String(error).slice(0, 120));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await ctx.dispose();
    return samples;
  })();
  return {
    stop: async () => {
      running = false;
      return loop;
    },
    errors,
  };
}

/** Sample the client frame profile once per animation frame. */
async function sampleFrames(
  page: import('@playwright/test').Page,
  frames: number,
): Promise<Sample[]> {
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

function report(title: string, rows: Array<[string, ReturnType<typeof stat>]>): string {
  const lines = [`\n=== ${title} ===`];
  lines.push(`  ${'metric'.padEnd(18)}${'avg'.padStart(10)}${'p50'.padStart(10)}`
    + `${'p95'.padStart(10)}${'max'.padStart(10)}`);
  for (const [name, s] of rows) {
    lines.push(`  ${name.padEnd(18)}${s.avg.toFixed(2).padStart(10)}`
      + `${s.p50.toFixed(2).padStart(10)}${s.p95.toFixed(2).padStart(10)}`
      + `${s.max.toFixed(2).padStart(10)}`);
  }
  return lines.join('\n');
}

test.describe('remote box stress', () => {
  test.skip(!ENABLED, 'set E2E_STRESS=1 and E2E_BASE_URL to a running box');

  test('scripted demolition, client frames and server physics', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const baseUrl = process.env.E2E_BASE_URL!;
    expect(baseUrl, 'E2E_BASE_URL must point at the box').toBeTruthy();

    const poll = startServerPoll(baseUrl);

    await openCity(page);
    await waitForCityRendered(page);

    const restFrames = await sampleFrames(page, 180);
    const restMark = Date.now();
    const beforeStats = await cityStats(page);

    // Bring down as many structures as the box has, up to the cap. The load
    // case is thousands of live bodies being recomposed, not an intact city.
    const targets = await allStructureTargets(page);
    const chosen = targets.slice(0, TARGETS);
    console.log(`[stress] ${LABEL}: ${targets.length} structures, demolishing ${chosen.length}`);
    for (const target of chosen) {
      await fireAt(page, target, SHOTS, { intervalMs: 120, holdMs: 900 });
    }

    const loadFrames = await sampleFrames(page, 240);
    const afterStats = await cityStats(page);
    // Let the rubble settle so the tail is measured too, not just the peak.
    await page.waitForTimeout(15_000);
    const settleFrames = await sampleFrames(page, 120);

    const serverSamples = await poll.stop();
    const during = serverSamples.filter((s) => s.t >= restMark);

    const pick = (rows: Sample[], key: string): number[] => rows.map((r) => r[key] ?? 0);
    const clientRows = (rows: Sample[]): Array<[string, ReturnType<typeof stat>]> => [
      ['frameTotalMs', stat(pick(rows, 'frameTotalMs'))],
      ['cpuFrameMs', stat(pick(rows, 'cpuFrameMs'))],
      ['glRenderMs', stat(pick(rows, 'glRenderMs'))],
      ['decodeMs', stat(pick(rows, 'decodeMs'))],
      ['unattributedMs', stat(pick(rows, 'unattributedMs'))],
      ['drawCalls', stat(pick(rows, 'drawCalls'))],
    ];

    const out: string[] = [];
    out.push(report(`${LABEL} client @ rest`, clientRows(restFrames)));
    out.push(report(`${LABEL} client @ demolition`, clientRows(loadFrames)));
    out.push(report(`${LABEL} client @ settle`, clientRows(settleFrames)));
    if (during.length > 0) {
      out.push(report(`${LABEL} server physics (${during.length} samples @1Hz)`, [
        ['stepMs', stat(pick(during, 'stepMs'))],
        ['simulateMs', stat(pick(during, 'simulateMs'))],
        ['fetchMs', stat(pick(during, 'fetchMs'))],
        ['gpuWaitMs', stat(pick(during, 'gpuWaitMs'))],
        ['fetchCopyMs', stat(pick(during, 'fetchCopyMs'))],
        ['activeBodies', stat(pick(during, 'activeBodies'))],
        ['contactPairs', stat(pick(during, 'contactPairs'))],
      ]));
      const last = during[during.length - 1];
      out.push(`  gpu_active=${last.gpuActive} gpu_warnings=${last.gpuWarnings} `
        + `chunks=${last.chunkCount} dynamic_bodies=${last.dynamicBodies}`);
    } else {
      out.push(`\n=== ${LABEL} server physics ===\n  NO SAMPLES `
        + `(errors: ${poll.errors.slice(0, 3).join(' | ') || 'none'})`);
    }
    out.push(`\n[stress] ${LABEL} city: `
      + `chunks ${beforeStats.chunksAwake}->${afterStats.chunksAwake} awake, `
      + `bonds broken ${afterStats.brokenBonds}, islands ${afterStats.liveIslands}`);

    const text = out.join('\n');
    console.log(text);

    // The raw samples travel with the run so a later change can be compared
    // against this one rather than against a remembered number.
    const artifact = path.join(testInfo.outputDir, `stress-${LABEL}.json`);
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({
      label: LABEL,
      baseUrl,
      restFrames,
      loadFrames,
      settleFrames,
      serverSamples,
      beforeStats,
      afterStats,
    }, null, 2));
    await testInfo.attach(`stress-${LABEL}.json`, { path: artifact });
    testInfo.annotations.push({ type: 'stress', description: text });

    // Deliberately only a liveness assertion. Absolute budgets belong to the
    // box being measured -- reporting them is the point, failing on them here
    // would just encode one machine's numbers as everyone's.
    expect(loadFrames.length, 'client kept producing frames under demolition')
      .toBeGreaterThan(0);
  });
});
