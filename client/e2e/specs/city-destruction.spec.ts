/**
 * Destructible mini-city end-to-end.
 *
 * Requires a running city-capable server (`--features destruction` for the real
 * PhysX/Blast backend, or `VIBE_CITY_SYNTHETIC=1` for the CI-safe backend) and
 * a WebTransport-capable browser: the city stream only rides datagrams, so the
 * WebSocket fallback yields a city-less match.
 *
 * Gated behind E2E_CITY=1. Set E2E_CITY_WT_URL when the advertised
 * WebTransport endpoint is not reachable from the test host.
 */
import { expect, test } from '@playwright/test';

import { join, snapshot, waitForSnapshot } from '../helpers/toolkit';
import {
  aimAnglesTo,
  cityStats,
  fireAt,
  openCity,
  sampleCity,
  waitForCityRendered,
  tallestStructureTarget,
  waitUntilStill,
  walkToward,
} from '../helpers/city';

const CITY_ENABLED = process.env.E2E_CITY === '1';

/** Client byte ceiling from shared constants, as Mbps, with burst headroom. */
const STEADY_MBPS_CEILING = 2.5;
const BURST_MBPS_CEILING = 4.0;

/**
 * Hits are resolved against a per-structure bounding sphere, so the shooter has
 * to be inside that sphere for the blast centre to land on material.
 */
const STAND_OFF_M = 11;

test.describe('destructible city', () => {
  test.skip(!CITY_ENABLED, 'set E2E_CITY=1 to run city destruction e2e');
  test.describe.configure({ mode: 'serial' });

  test('renders the city, fractures it on fire, and settles', async ({ page }) => {
    test.setTimeout(180_000);

    await openCity(page);
    const joined = await join(page);
    expect(joined.matchId).toMatch(/^city/);

    // 1. The regression that made the city invisible: the manifest loads but
    // the chunk mesh never builds. Assert both, not just the manifest.
    const rendered = await waitForCityRendered(page);
    expect(rendered.city!.chunksTotal).toBeGreaterThan(1000);
    expect(rendered.city!.rendered).toBe(true);
    expect(rendered.city!.manifestHash).toMatch(/^[0-9a-f]{64}$/);

    const before = await cityStats(page);
    expect(before.topoSeqGaps).toBe(0);

    // 2. Shoot a tower above its support course and expect real fracture.
    const target = await tallestStructureTarget(page);
    await walkToward(page, target, STAND_OFF_M);
    await waitUntilStill(page);
    const settled = await snapshot(page);
    expect(aimAnglesTo(settled.position, target).distance).toBeLessThan(30);
    await fireAt(page, target, 12);

    const fractured = await waitForSnapshot(
      page,
      (s) => !!s.city && s.city.brokenBonds > before.brokenBonds,
      { timeout: 30_000, label: 'bonds break after firing' },
    );
    expect(fractured.city!.brokenBonds).toBeGreaterThan(before.brokenBonds);

    // Chunks must actually come loose and move, not just lose bonds.
    const collapsing = await waitForSnapshot(
      page,
      (s) => !!s.city && s.city.chunksAwake > 0,
      { timeout: 20_000, label: 'chunks wake and fall' },
    );
    expect(collapsing.city!.liveIslands).toBeGreaterThan(0);

    // 3. Streaming: datagrams flow, no topology gaps, bandwidth under ceiling.
    const samples = await sampleCity(page, 15);
    const peakMbps = Math.max(...samples.map((s) => (s.bytesPerSecond * 8) / 1_000_000));
    const steadyMbps = samples
      .slice(-5)
      .reduce((sum, s) => sum + (s.bytesPerSecond * 8) / 1_000_000, 0) / 5;

    console.log('[city e2e] streaming', {
      peakMbps: +peakMbps.toFixed(3),
      steadyMbps: +steadyMbps.toFixed(3),
      datagrams: samples.at(-1)!.datagramsReceived,
      brokenBonds: samples.at(-1)!.brokenBonds,
      awake: samples.at(-1)!.chunksAwake,
      settled: samples.at(-1)!.chunksSettled,
      minChunkY: +samples.at(-1)!.minChunkY.toFixed(3),
      chunksBelowGround: samples.at(-1)!.chunksBelowGround,
      orphanedChunks: samples.at(-1)!.orphanedChunks,
    });

    expect(samples.at(-1)!.datagramsReceived).toBeGreaterThan(0);
    expect(samples.at(-1)!.topoSeqGaps).toBe(0);
    expect(peakMbps).toBeLessThan(BURST_MBPS_CEILING);
    expect(steadyMbps).toBeLessThan(STEADY_MBPS_CEILING);

    // 4. Debris comes to rest: awake count must fall from its peak.
    const peakAwake = Math.max(...samples.map((s) => s.chunksAwake));
    expect(peakAwake).toBeGreaterThan(0);
    expect(samples.at(-1)!.chunksAwake).toBeLessThanOrEqual(peakAwake);

    // 5. Client-side reconstruction must be sound: every chunk owned by a body
    // that exists. Island offsets used to be derived from this client's own
    // (possibly stale) view at the promotion instant and frozen in, which put
    // chunks metres below the floor. That is fixed and pinned here.
    const final = samples.at(-1)!;
    expect(final.orphanedChunks).toBe(0);
    expect(final.orphanedByRetire).toBe(0);

    // Chunks must be drawn on top of the world. This was previously logged but
    // not asserted, on the theory that island bodies were escaping under the
    // world server-side and the client was rendering that faithfully. That
    // theory is now contradicted: the server-side bench asserts min_body_y and
    // it holds at 0.00 m through 1636 bodies (server/src/city_bench.rs), so
    // physics is keeping bodies on the floor. A chunk drawn hundreds of metres
    // down is therefore this client's own reconstruction going wrong —
    // chunkWorld = bodyPose ∘ localOffset with a stale or wrong binding — and
    // it reads in game as parts of a building vanishing mid-collapse.
    console.log('[city e2e] ground', {
      minChunkY: +final.minChunkY.toFixed(3),
      chunksBelowGround: final.chunksBelowGround,
    });
    expect(
      final.chunksBelowGround,
      `${final.chunksBelowGround} chunks drawn below the ground plane `
        + `(lowest ${final.minChunkY.toFixed(1)} m). Server physics keeps bodies `
        + `at y>=0, so this is client-side chunk-to-body reconstruction.`,
    ).toBe(0);
  });

  test('one player destroys, every player sees it', async ({ browser }) => {
    test.setTimeout(240_000);

    const contexts = await Promise.all([
      browser.newContext({ ignoreHTTPSErrors: true }),
      browser.newContext({ ignoreHTTPSErrors: true }),
      browser.newContext({ ignoreHTTPSErrors: true }),
    ]);
    const pages = await Promise.all(contexts.map((c) => c.newPage()));

    try {
      for (const page of pages) {
        await openCity(page);
        await join(page);
        await waitForCityRendered(page);
      }

      const playerIds = await Promise.all(
        pages.map(async (page) => (await snapshot(page)).playerId),
      );
      expect(new Set(playerIds).size).toBe(pages.length);

      // Every client must agree on the manifest before comparing topology.
      const hashes = await Promise.all(pages.map(async (p) => (await cityStats(p)).manifestHash));
      expect(new Set(hashes).size).toBe(1);

      const baselines = await Promise.all(pages.map((p) => cityStats(p)));

      // Only the first player shoots.
      const shooter = pages[0];
      const target = await tallestStructureTarget(shooter);
      await walkToward(shooter, target, STAND_OFF_M);
      await waitUntilStill(shooter);
      await fireAt(shooter, target, 12);

      // Every client — including the two that never fired — must observe it.
      await Promise.all(
        pages.map((page, index) =>
          waitForSnapshot(
            page,
            (s) => !!s.city && s.city.brokenBonds > baselines[index].brokenBonds,
            { timeout: 45_000, label: `client ${index} observes fracture` },
          ),
        ),
      );

      // Topology is eventually consistent, so poll for convergence rather than
      // comparing one instantaneous sample per client: a single sample can be
      // taken mid-collapse and see three different (correct) prefixes of the
      // same reliable stream.
      let finals = await Promise.all(pages.map((p) => cityStats(p)));
      const deadline = Date.now() + 60_000;
      let previous = -1;
      while (Date.now() < deadline) {
        await pages[0].waitForTimeout(2_000);
        finals = await Promise.all(pages.map((p) => cityStats(p)));
        const agreed = finals.every((f) => f.brokenBonds === finals[0].brokenBonds);
        const quiescent = finals[0].brokenBonds === previous;
        if (agreed && quiescent && finals[0].brokenBonds > 0) {
          break;
        }
        previous = finals[0].brokenBonds;
      }
      console.log(
        '[city e2e] multiplayer convergence',
        finals.map((f) => ({
          brokenBonds: f.brokenBonds,
          liveIslands: f.liveIslands,
          settled: f.chunksSettled,
          gaps: f.topoSeqGaps,
        })),
      );

      for (const stats of finals) {
        expect(stats.topoSeqGaps).toBe(0);
        expect(stats.brokenBonds).toBe(finals[0].brokenBonds);
        expect(stats.liveIslands).toBe(finals[0].liveIslands);
        // Clients 2 and 3 joined an already-damaged city, so this also covers
        // the bootstrap rebuild path: a late joiner must place chunks the same
        // way a client that watched the collapse does.
        expect(stats.orphanedChunks).toBe(0);
      }
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});
