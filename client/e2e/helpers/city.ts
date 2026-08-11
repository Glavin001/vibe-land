/**
 * Destructible-city E2E helpers.
 *
 * Aiming goes through `window.__VIBE_DRIVE__` rather than synthetic mouse
 * deltas: headless Chromium cannot grant pointer lock, and hitting a specific
 * building face needs absolute angles, not relative look deltas. Reads still
 * go through the read-only `__VIBE_E2E__` bridge.
 */
import type { Page } from '@playwright/test';
import type { CityE2EStats, GameE2ESnapshot } from './types';
import { snapshot, waitForSnapshot } from './toolkit';

/** Server-side eye height used for hitscan ray origins (PLAYER_EYE_HEIGHT_M). */
export const PLAYER_EYE_HEIGHT_M = 0.8;

/**
 * A point on the tallest building, read from the authoritative manifest.
 *
 * Never hardcode grid coordinates: the pitch is derived from the scene pack's
 * footprint, so it changes when the pack changes. `aimHeightFraction` picks a
 * height up the tower — aim above the ground course, whose bonds are anchored
 * to the foundation and far stronger than the floors above.
 */
export async function tallestStructureTarget(
  page: Page,
  aimHeightFraction = 0.6,
): Promise<[number, number, number]> {
  const { manifestHash } = await cityStats(page);
  const target = await page.evaluate(async (hash) => {
    const response = await fetch(`/city-manifest/${hash}`);
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    const manifest = await response.json();
    let best: { pos: number[]; top: number; chunks: number } | null = null;
    for (const structure of manifest.structures) {
      const top = Math.max(...structure.chunks.map((c: any) => c.centroid[1]));
      if (!best || structure.chunks.length > best.chunks) {
        best = { pos: structure.worldPosition, top, chunks: structure.chunks.length };
      }
    }
    if (!best) throw new Error('manifest has no structures');
    return { x: best.pos[0], y: best.pos[1] + best.top, z: best.pos[2] };
  }, manifestHash);
  return [target.x, target.y * aimHeightFraction, target.z];
}

/**
 * Every structure's aim point, biggest first.
 *
 * The single-tower helper caps out around 300 islands, which is far below the
 * scale where reconstruction faults have been reported (2000+). Levelling many
 * towers is what gets there.
 */
export async function allStructureTargets(
  page: Page,
  aimHeightFraction = 0.35,
): Promise<Array<[number, number, number]>> {
  const { manifestHash } = await cityStats(page);
  const targets = await page.evaluate(async (hash) => {
    const response = await fetch(`/city-manifest/${hash}`);
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    const manifest = await response.json();
    return manifest.structures
      .map((structure: any) => ({
        chunks: structure.chunks.length,
        pos: structure.worldPosition,
        top: Math.max(...structure.chunks.map((c: any) => c.centroid[1])),
      }))
      .sort((a: any, b: any) => b.chunks - a.chunks)
      .map((s: any) => [s.pos[0], s.pos[1] + s.top, s.pos[2]] as [number, number, number]);
  }, manifestHash);
  return targets.map(
    (t: [number, number, number]) =>
      [t[0], t[1] * aimHeightFraction, t[2]] as [number, number, number],
  );
}

/**
 * Point the WebTransport endpoint at a locally reachable address.
 *
 * The server advertises its public URL in `/session-config`. A test runner on
 * the same host usually cannot hairpin back through the NAT to that address,
 * so `E2E_CITY_WT_URL` lets the spec rewrite it. No-op when unset.
 */
export async function routeWebTransportOverride(page: Page): Promise<void> {
  const override = process.env.E2E_CITY_WT_URL;
  if (!override) return;
  await page.route('**/session-config*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.url = override;
    await route.fulfill({
      response,
      body: JSON.stringify(body),
      headers: { ...response.headers(), 'content-type': 'application/json' },
    });
  });
}

/** Open the `/city` route and wait for the E2E bridge to install. */
export async function openCity(page: Page): Promise<void> {
  await routeWebTransportOverride(page);
  await page.goto('/city', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).__VIBE_E2E__, { timeout: 30_000 });
}

/** Read city stats, throwing a useful error when the match is not a city match. */
export async function cityStats(page: Page): Promise<CityE2EStats> {
  const s = await snapshot(page);
  if (!s.city) {
    throw new Error(
      `no city stats on snapshot (matchId=${s.matchId}, connected=${s.connected}). `
        + 'The city layer publishes stats every ~30 frames once the manifest loads.',
    );
  }
  return s.city;
}

/** Wait until the manifest has loaded and the chunk mesh has been built. */
export async function waitForCityRendered(
  page: Page,
  options?: { timeout?: number },
): Promise<GameE2ESnapshot> {
  return waitForSnapshot(
    page,
    (s) => !!s.city && s.city.chunksTotal > 0 && s.city.rendered,
    { timeout: options?.timeout ?? 60_000, label: 'waitForCityRendered' },
  );
}

/** Absolute yaw/pitch from the player's eye toward a world point. */
export function aimAnglesTo(
  position: [number, number, number],
  target: [number, number, number],
): { yaw: number; pitch: number; distance: number } {
  const dx = target[0] - position[0];
  const dy = target[1] - (position[1] + PLAYER_EYE_HEIGHT_M);
  const dz = target[2] - position[2];
  const horizontal = Math.hypot(dx, dz);
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(dy, Math.max(1e-4, horizontal)),
    distance: Math.hypot(horizontal, dy),
  };
}

/** Face a world point from the current position, corrected for eye height. */
export async function aimAt(
  page: Page,
  target: [number, number, number],
): Promise<{ yaw: number; pitch: number; distance: number }> {
  const s = await snapshot(page);
  const angles = aimAnglesTo(s.position, target);
  await page.evaluate(
    ([yaw, pitch]) => (window as any).__VIBE_DRIVE__.look(yaw, pitch),
    [angles.yaw, angles.pitch],
  );
  await page.waitForTimeout(300);
  return angles;
}

/** Walk toward a world point until within `stopWithinM`, or give up. */
export async function walkToward(
  page: Page,
  target: [number, number, number],
  stopWithinM: number,
  options?: { maxSteps?: number },
): Promise<number> {
  const maxSteps = options?.maxSteps ?? 30;
  let distance = Infinity;
  for (let step = 0; step < maxSteps; step += 1) {
    const s = await snapshot(page);
    const angles = aimAnglesTo(s.position, target);
    distance = angles.distance;
    if (distance <= stopWithinM) break;
    await page.evaluate((yaw) => (window as any).__VIBE_DRIVE__.look(yaw, 0), angles.yaw);
    await page.evaluate(() => (window as any).__VIBE_DRIVE__.move({ forward: 1, durationMs: 1200 }));
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => (window as any).__VIBE_DRIVE__.stop());
  await page.waitForTimeout(400);
  return distance;
}

/** Fire `count` shots through the drive bridge, holding the current aim. */
export async function fireBurst(
  page: Page,
  count: number,
  options?: { intervalMs?: number; holdMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 350;
  const holdMs = options?.holdMs ?? 120;
  for (let i = 0; i < count; i += 1) {
    await page.evaluate((hold) => (window as any).__VIBE_DRIVE__.fire({ holdMs: hold }), holdMs);
    await page.waitForTimeout(intervalMs);
  }
}

/**
 * Fire at a world point, re-aiming from the live position before every shot.
 *
 * Absolute angles go stale: the character keeps sliding for up to a second
 * after movement stops, and the server builds the hitscan ray from its own
 * authoritative position. Aiming once and then firing a burst drifts wide.
 */
export async function fireAt(
  page: Page,
  target: [number, number, number],
  count: number,
  options?: { intervalMs?: number; holdMs?: number },
): Promise<void> {
  const intervalMs = options?.intervalMs ?? 350;
  const holdMs = options?.holdMs ?? 120;
  for (let i = 0; i < count; i += 1) {
    await aimAt(page, target);
    await page.evaluate((hold) => (window as any).__VIBE_DRIVE__.fire({ holdMs: hold }), holdMs);
    await page.waitForTimeout(intervalMs);
  }
}

/** Wait until the authoritative position stops changing (post-walk slide). */
export async function waitUntilStill(
  page: Page,
  options?: { timeout?: number; toleranceM?: number },
): Promise<void> {
  const timeout = options?.timeout ?? 6000;
  const tolerance = options?.toleranceM ?? 0.05;
  const deadline = Date.now() + timeout;
  let previous = (await snapshot(page)).position;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const current = (await snapshot(page)).position;
    const moved = Math.hypot(
      current[0] - previous[0],
      current[1] - previous[1],
      current[2] - previous[2],
    );
    if (moved < tolerance) return;
    previous = current;
  }
}

/** Sample city stats once per second for `seconds`, for bandwidth assertions. */
export async function sampleCity(
  page: Page,
  seconds: number,
): Promise<CityE2EStats[]> {
  const samples: CityE2EStats[] = [];
  for (let i = 0; i < seconds; i += 1) {
    await page.waitForTimeout(1000);
    samples.push(await cityStats(page));
  }
  return samples;
}
