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
 * The server advertises its PUBLIC url in `/session-config`, and a runner on
 * the same host cannot hairpin UDP back through the NAT to reach it: the QUIC
 * handshake times out and the client quietly falls back to WebSocket. That
 * fallback is worse than a failure, because the suite then measures a
 * transport no player uses -- reliable and ordered, where the real one is
 * lossy datagrams. A whole investigation was run against the wrong wire
 * before this was noticed.
 *
 * So the override is now the DEFAULT (the server always listens on 4434
 * locally), not an opt-in. `E2E_CITY_WT_URL` still overrides it for a remote
 * stack.
 */
const DEFAULT_WT_URL = 'https://127.0.0.1:4434/game';

export async function routeWebTransportOverride(page: Page): Promise<void> {
  const override = process.env.E2E_CITY_WT_URL ?? DEFAULT_WT_URL;
  if (!override || override === 'off') return;
  await page.route('**/session-config*', async (route) => {
    // Retry on an empty/!ok body. The dev server proxies this to the game
    // server, and a request that lands mid-restart comes back empty -- which
    // threw "Unexpected end of JSON input" out of the route handler, failed
    // the spec with no bearing on what it was testing, and cost several runs
    // to recognise as infrastructure rather than a regression.
    let response = await route.fetch();
    let raw = await response.text();
    for (let attempt = 0; attempt < 5 && (!response.ok() || raw.trim() === ''); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await route.fetch();
      raw = await response.text();
    }
    if (raw.trim() === '') {
      throw new Error(
        'session-config returned an empty body after 5 attempts: the game '
          + 'server is not up. Start it before running the city specs.',
      );
    }
    const body = JSON.parse(raw);
    body.url = override;
    await route.fulfill({
      response,
      body: JSON.stringify(body),
      headers: { ...response.headers(), 'content-type': 'application/json' },
    });
  });
}

/**
 * Fail loudly if the session did not end up on WebTransport.
 *
 * The client falls back to WebSocket by design when QUIC will not connect,
 * which is right for players and wrong for a test: the two transports differ
 * in exactly the way that matters for the pose stream (unreliable datagrams
 * versus an ordered reliable stream). Set E2E_ALLOW_WS=1 for the rare spec
 * that genuinely wants the fallback path.
 */
async function assertRealTransport(page: Page): Promise<void> {
  if (process.env.E2E_ALLOW_WS === '1') return;
  const transport = await page.evaluate(
    () => (window as unknown as { __VIBE_E2E__?: { snapshot: () => { transport: string } } })
      .__VIBE_E2E__?.snapshot().transport ?? 'none',
  );
  if (transport !== 'webtransport') {
    throw new Error(
      `city spec is running over '${transport}', not WebTransport. The suite would `
        + 'then exercise an ordered reliable stream while players get lossy datagrams. '
        + 'Check the game server\'s UDP listener (4434) and E2E_CITY_WT_URL, or set '
        + 'E2E_ALLOW_WS=1 if this spec really wants the fallback.',
    );
  }
}

/** Open the `/city` route and wait for the E2E bridge to install. */
export async function openCity(page: Page): Promise<void> {
  await routeWebTransportOverride(page);
  // E2E_CITY_URL_PARAMS lets a locally-started stack join the way netlab
  // does (`portal=true&match=...`); plain /city needs the matchmaking flow.
  const params = process.env.E2E_CITY_URL_PARAMS;
  await page.goto(params ? `/city?${params}` : '/city', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).__VIBE_E2E__, { timeout: 30_000 });
  // Press the join overlay (netlab does the same): joining and gameplay input
  // both hang off this gesture, and the drive bridge's fire path needs it.
  const viewport = page.viewportSize();
  if (viewport) {
    await page.mouse.click(viewport.width / 2, viewport.height / 2);
  }
  // Wait for the transport to be decided, then insist it is the real one.
  await page.waitForFunction(
    () => {
      const bridge = (window as unknown as {
        __VIBE_E2E__?: { snapshot: () => { transport: string } };
      }).__VIBE_E2E__;
      const transport = bridge?.snapshot().transport ?? 'none';
      return transport === 'webtransport' || transport === 'websocket';
    },
    { timeout: 30_000 },
  );
  await assertRealTransport(page);
  // The per-chunk diagnostic sweeps are gated on the panel being visible,
  // because they cost 3.1 ms at downtown's chunk count and a player never reads
  // them. Specs assert on `minChunkY`, `chunksBelowGround`, `deepest` and
  // `staleDrawnChunks`, so ask for them explicitly rather than depending on
  // whether the overlay happened to be on screen.
  await page.evaluate(() => {
    (window as unknown as { __VIBE_E2E__?: { setDiagnostics?: (on: boolean) => void } })
      .__VIBE_E2E__?.setDiagnostics?.(true);
  });
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

/**
 * Hide every DOM overlay, leaving only the WebGL canvas.
 *
 * Screenshots of the city are evidence about the RENDER, and the stats panel
 * covers the left third while the controls card covers the bottom -- which is
 * most of what a texture or lighting shot exists to show. Clicking the
 * overlays' own collapse buttons is unreliable: they sit under the canvas and
 * are not always hittable, and a click with no timeout waits for actionability
 * forever, which reads as the spec hanging.
 *
 * Visibility rather than display, so nothing reflows and the canvas keeps its
 * size -- a resize would change the aspect ratio between two shots meant to be
 * compared.
 */
export async function hideDomOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return;
    const ancestors = new Set<Node>();
    for (let node: Node | null = canvas; node; node = node.parentNode) ancestors.add(node);
    document.querySelectorAll('body *').forEach((element) => {
      if (ancestors.has(element) || canvas.contains(element)) return;
      (element as HTMLElement).style.visibility = 'hidden';
    });
  });
}

/**
 * Queue a server-side rebuild of the city, and wait for it to land.
 *
 * Specs that photograph or measure intact buildings need them intact, and the
 * server keeps whatever the last run knocked down -- so a second run against a
 * live server sees the first run's rubble. The reset is asynchronous (the
 * handler only queues it), hence the wait on the bond count climbing back.
 */
export async function resetCity(page: Page): Promise<void> {
  const before = (await cityStats(page)).brokenBonds;
  if (before === 0) return;
  const matchId = (await snapshot(page)).matchId;
  const response = await page.request.post(`/city-reset/${matchId}`, { failOnStatusCode: false });
  if (!response.ok()) throw new Error(`city-reset returned ${response.status()}`);
  // An absolute floor, not a fraction of what was there. "Half of last time"
  // let a run start from 3,376 already-broken bonds and call it reset, which
  // makes two perf runs incomparable for a reason that has nothing to do with
  // what they are measuring.
  await waitForSnapshot(page, (s) => !!s.city && s.city.brokenBonds < 200, {
    timeout: 60_000,
    label: 'resetCity',
  });
  // The rebuild re-bootstraps the ledger; give the client a moment to draw it.
  await page.waitForTimeout(2000);
}

/** Extent of the city's chunks, for placing a capture camera around it. */
export interface CityBounds {
  centre: [number, number, number];
  /** Horizontal half-diagonal, i.e. how far out "outside the city" starts. */
  radiusM: number;
  topM: number;
}

export async function cityBounds(page: Page): Promise<CityBounds> {
  const { manifestHash } = await cityStats(page);
  return page.evaluate(async (hash) => {
    const response = await fetch(`/city-manifest/${hash}`);
    if (!response.ok) throw new Error(`manifest fetch failed: ${response.status}`);
    const manifest = await response.json();
    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    let top = 0;
    for (const structure of manifest.structures) {
      for (const chunk of structure.chunks) {
        const x = structure.worldPosition[0] + chunk.centroid[0];
        const y = structure.worldPosition[1] + chunk.centroid[1];
        const z = structure.worldPosition[2] + chunk.centroid[2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
        if (y > top) top = y;
      }
    }
    return {
      centre: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2] as [number, number, number],
      radiusM: 0.5 * Math.hypot(maxX - minX, maxZ - minZ),
      topM: top,
    };
  }, manifestHash);
}

/**
 * Park the capture camera outside the city, looking back across it.
 *
 * The vantage is derived from the city's own extent rather than from the
 * player, so it is identical in every run -- which is the only way two
 * candidates for a perceptual knob can be compared at all.
 */
export async function parkOutside(
  page: Page,
  bounds: CityBounds,
  options?: { standOffM?: number; heightM?: number; bearingRad?: number; aimFraction?: number },
): Promise<void> {
  const standOff = options?.standOffM ?? 70;
  const height = options?.heightM ?? 26;
  const bearing = options?.bearingRad ?? Math.PI * 0.25;
  const aim = options?.aimFraction ?? 0.42;
  const distance = bounds.radiusM + standOff;
  await page.evaluate(
    (pose) => (window as unknown as {
      __VIBE_E2E__: { setCapturePose: (p: unknown) => void };
    }).__VIBE_E2E__.setCapturePose(pose),
    {
      position: [
        bounds.centre[0] + Math.sin(bearing) * distance,
        height,
        bounds.centre[2] + Math.cos(bearing) * distance,
      ] as [number, number, number],
      lookAt: [bounds.centre[0], bounds.topM * aim, bounds.centre[2]] as [number, number, number],
    },
  );
  await page.waitForTimeout(400);
}
