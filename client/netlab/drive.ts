/**
 * Executes a scenario's drive timeline in a page via window.__VIBE_DRIVE__.
 *
 * Commands map 1:1 onto the drive bridge, plus a few runner-level verbs:
 *  - "mark": recorder marker (also flashes the screen for video alignment)
 *  - "watch": aim this client at another client's player each 500 ms
 */

import type { Page } from '@playwright/test';

export interface DriveStep {
  /** Milliseconds after scenario start. */
  at: number;
  cmd: string;
  args?: unknown;
}

export interface DriveClientSpec {
  role: string;
  /**
   * Wait this long before this client navigates.
   *
   * Lets a scenario reproduce a late join: one client destroys and lets the
   * rubble settle, then another arrives to a world it never saw change.
   */
  joinDelayMs?: number;
  /** Client index (or role name) whose player this client keeps looking at. */
  watch?: string;
  drive?: DriveStep[];
}

async function callDrive(page: Page, cmd: string, args: unknown): Promise<void> {
  await page.evaluate(
    ([c, a]) => {
      const drive = (window as any).__VIBE_DRIVE__;
      if (!drive) throw new Error('__VIBE_DRIVE__ bridge not found');
      const fn = drive[c as string];
      if (typeof fn !== 'function') throw new Error(`unknown drive command: ${c}`);
      if (Array.isArray(a)) return fn.apply(drive, a);
      if (a === undefined) return fn.call(drive);
      return fn.call(drive, a);
    },
    [cmd, args] as [string, unknown],
  );
}

/**
 * Emulates Chrome's background-tab behaviour: rAF stops, network keeps
 * running. Deterministic (no real window occlusion needed), and it isolates
 * exactly the property under test — the render loop pausing while the
 * reliable stream keeps mutating the ledger.
 */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__netlabHiddenRaf) return;
    w.__netlabHiddenRaf = { orig: w.requestAnimationFrame.bind(w), queued: [] as FrameRequestCallback[] };
    w.requestAnimationFrame = (cb: FrameRequestCallback) => {
      w.__netlabHiddenRaf.queued.push(cb);
      return 0;
    };
  });
}

async function showTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    const h = w.__netlabHiddenRaf;
    if (!h) return;
    w.requestAnimationFrame = h.orig;
    // Every consumer whose frame was swallowed re-registers when it runs, so
    // firing the queued callbacks once restarts each loop.
    const queued: FrameRequestCallback[] = h.queued;
    delete w.__netlabHiddenRaf;
    for (const cb of queued.slice(-8)) h.orig(cb);
  });
}

async function mark(page: Page, label: string): Promise<void> {
  await page.evaluate((l) => {
    (window as any).__VIBE_RECORDER__?.mark(l);
  }, label);
}

/**
 * Run a drive timeline to completion. Steps fire relative to `startedAtMs`
 * (a shared origin lets multiple clients' timelines stay aligned).
 */
export async function runDriveTimeline(
  page: Page,
  steps: DriveStep[],
  startedAtMs: number,
  label: string,
): Promise<void> {
  const ordered = [...steps].sort((a, b) => a.at - b.at);
  for (const step of ordered) {
    const wait = startedAtMs + step.at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await mark(page, `${label}:${step.cmd}@${step.at}`);
      if (step.cmd === 'mark') {
        // Marker only — already emitted above.
        continue;
      }
      if (step.cmd === 'huntLargestIsland') {
        // Keep firing at the biggest island while re-aiming at it every pulse:
        // a monolith tips and flies, so a fixed aim point stops hitting it and
        // the test would "pass" by never landing a shot.
        const durationMs = Number((step.args as { durationMs?: number })?.durationMs ?? 20000);
        const until = Date.now() + durationMs;
        while (Date.now() < until) {
          const island = await page
            .evaluate(() => (window as any).__VIBE_CITY_DEBUG__?.largestIsland?.() ?? null)
            .catch(() => null);
          if (island?.center) {
            await callDrive(page, 'lookAt', island.center);
            await callDrive(page, 'fire', { holdMs: 700 });
          }
          await new Promise((r) => setTimeout(r, 700));
        }
        continue;
      }
      if (step.cmd === 'hideTab') {
        await hideTab(page);
        continue;
      }
      if (step.cmd === 'showTab') {
        await showTab(page);
        continue;
      }
      await callDrive(page, step.cmd, step.args);
    } catch (err) {
      console.warn(`[netlab] drive step failed (${label} ${step.cmd}@${step.at}):`, err);
    }
  }
}

/**
 * Keep `observer` looking at `target`'s player until the returned stop()
 * is called. Reads the target's position from its own E2E bridge.
 */
export function startWatch(observer: Page, target: Page): { stop(): void } {
  let active = true;
  void (async () => {
    while (active) {
      try {
        const snap = await target.evaluate(() => {
          const b = (window as any).__VIBE_E2E__;
          return b ? { position: b.snapshot().position } : null;
        });
        if (snap && active) {
          await callDrive(observer, 'lookAt', snap.position);
        }
      } catch {
        // Target page may be mid-navigation; keep trying.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return {
    stop() {
      active = false;
    },
  };
}
