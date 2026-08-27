/**
 * Load driver for the observer-pipeline A/B (Lever B).
 *
 * The trace harness (record-city-trace) runs its OWN loop, not main.rs's, so
 * it cannot see the observer pipeline at all — and with no player connected
 * the observer tail costs nothing, because there is nobody to encode for.
 * Measuring B therefore needs the real server loop with a real client
 * attached, which is what this spec provides: a scripted, repeatable
 * bombardment plus a per-tick sampler that writes the server's own
 * match-stats (timings, spans, the 300-tick ring) to JSONL.
 *
 * It asserts nothing about performance. It is a driver: the arms are
 * compared afterwards from the JSONL, by the same weighted-bucket logic the
 * trace comparisons use. What it DOES assert is that the run happened —
 * a driver that silently fails to shoot would make two arms look identical.
 *
 *   E2E_CITY=1 E2E_SKIP_WEB_SERVER=1 E2E_BASE_URL=https://127.0.0.1:8384 \
 *   OBS_SAMPLE_OUT=/tmp/obs-<arm>.jsonl \
 *     npx playwright test --config e2e/playwright.config.ts city-observer-pipeline-load
 */
import fs from 'fs';

import { expect, test } from '@playwright/test';

import {
  allStructureTargets,

  fireAt,
  openCity,
  waitForCityRendered,
  walkToward,
} from '../helpers/city';

/** Same stand-off the destruction specs use; shots connect from here. */
const STAND_OFF_M = 24;

const ENABLED = process.env.E2E_CITY === '1';
const SAMPLE_OUT = process.env.OBS_SAMPLE_OUT ?? '/tmp/obs-sample.jsonl';
/** Shots per target. Enough to bring towers down and hold a cascade. */
const SHOTS_PER_TARGET = Number(process.env.OBS_SHOTS ?? 14);
const TARGET_COUNT = Number(process.env.OBS_TARGETS ?? 4);

test.describe('observer pipeline load driver', () => {
  test.skip(!ENABLED, 'set E2E_CITY=1');
  test.setTimeout(600_000);

  test('scripted bombardment with per-tick server sampling', async ({ page }) => {
    await openCity(page);
    await waitForCityRendered(page);

    // Sampler runs in the page so it shares the client's own origin (the
    // match-stats endpoint is not exposed publicly) and cannot be skewed by
    // node<->server round trips.
    // Two samplers. The GET gives 2 Hz aggregates; the POST triggers a debug
    // report, whose server.json carries the registry copy's 300-tick ring —
    // the only per-tick source outside the trace harness, and the one that
    // makes bucket-matched comparison possible. Reports fire every 4 s so
    // consecutive 300-tick (5 s) rings overlap rather than leave holes.
    await page.evaluate(() => {
      (window as any).__OBS_SAMPLES__ = [];
      (window as any).__OBS_TIMER__ = setInterval(async () => {
        try {
          const response = await fetch('/match-stats/city-default');
          if (!response.ok) return;
          (window as any).__OBS_SAMPLES__.push(await response.json());
        } catch {
          /* a dropped sample is fine; the ring backfills */
        }
      }, 500);
      (window as any).__OBS_REPORT_TIMER__ = setInterval(async () => {
        try {
          await fetch('/match-stats/city-default/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: 'observer-pipeline-load' }),
          });
        } catch {
          /* ditto */
        }
      }, 4000);
    });

    const serverBrokenBonds = async () =>
      page.evaluate(async () => {
        const response = await fetch('/match-stats/city-default');
        if (!response.ok) throw new Error(`match-stats ${response.status}`);
        return (await response.json()).city.broken_bonds as number;
      });

    const targets = (await allStructureTargets(page)).slice(0, TARGET_COUNT);
    expect(targets.length).toBeGreaterThan(0);
    const before = await serverBrokenBonds();

    // Walk into range first. Spawn is ~90 m outside the city and shots fired
    // from there land on nothing: the first smoke run reported 0 broken bonds
    // with a perfectly healthy connection, which reads exactly like a broken
    // build.
    for (const target of targets) {
      await walkToward(page, target, STAND_OFF_M, { maxSteps: 30 });
      await fireAt(page, target, SHOTS_PER_TARGET, { intervalMs: 220 });
    }
    // Hold through the cascade and into the settle, which is where the
    // observer tail is largest (most awake bodies to encode).
    await page.waitForTimeout(25_000);

    const samples = await page.evaluate(() => {
      clearInterval((window as any).__OBS_TIMER__);
      clearInterval((window as any).__OBS_REPORT_TIMER__);
      return (window as any).__OBS_SAMPLES__;
    });
    fs.writeFileSync(
      SAMPLE_OUT,
      samples.map((sample: unknown) => JSON.stringify(sample)).join('\n') + '\n',
    );

    // The driver must actually have destroyed something: two arms driven by a
    // spec that silently stopped shooting would agree perfectly and mean
    // nothing.
    expect(await serverBrokenBonds()).toBeGreaterThan(before + 100);
    expect(samples.length).toBeGreaterThan(20);
  });
});
