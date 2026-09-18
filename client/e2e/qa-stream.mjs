/**
 * Measure streaming quality against a deliberately bad link.
 *
 * The physics and the destruction are settled; what a player still complains
 * about is what arrives. This drives the same agent through the same shots at
 * several link qualities and reports, for each, what the client ended up
 * drawing against what the server actually has.
 *
 * The link is degraded by a userspace UDP relay rather than by tc, because the
 * container has no NET_ADMIN. See helpers/netShaper.mjs.
 *
 *   node client/e2e/qa-stream.mjs
 *   node client/e2e/qa-stream.mjs --links "0/0/0, 60/20/0.02, 150/40/0.08"
 *
 *   --links <list>   semicolon or comma separated delay/jitter/loss triples,
 *                    delay and jitter in ms, loss as a fraction
 *   --shots <n>      shots per link.              default 6
 *   --settle <ms>    wait after joining.          default 8000
 *   --api <url>      server stats origin.         default http://127.0.0.1:4017
 *   --match <id>     match id.                    default city-default
 */
import { openCity, city, player } from './helpers/qaSession.mjs';
import { startShaper } from './helpers/netShaper.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const SHOTS = Number(arg('shots', 6));
const SETTLE = Number(arg('settle', 8000));
const LINKS = arg('links', '0/0/0, 40/10/0.005, 90/25/0.02, 180/60/0.08')
  .split(/[;,]/).map((s) => s.trim()).filter(Boolean)
  .map((spec) => {
    const [delayMs, jitterMs, loss] = spec.split('/').map(Number);
    return { delayMs: delayMs || 0, jitterMs: jitterMs || 0, loss: loss || 0 };
  });

const serverStats = async () => {
  try {
    const response = await fetch(`${API}/match-stats/${MATCH}`);
    return response.ok ? await response.json() : {};
  } catch { return {}; }
};

const reset = async () => {
  try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
};

const rows = [];
for (const link of LINKS) {
  await reset();
  await new Promise((r) => setTimeout(r, 4000));

  const shaper = await startShaper({ target: Number(arg('wt-port', 4433)), ...link });
  let browser;
  try {
    const session = await openCity({
      page: arg('page', 'https://127.0.0.1:1111'),
      wtPort: shaper.port,
      quiet: true,
    });
    browser = session.browser;
    const page = session.page;
    if (session.software) {
      console.error('refusing to measure streaming on a software renderer: the client cannot keep up with its own stream, and every number below would be about that instead of the link');
      await browser.close();
      shaper.stop();
      process.exit(1);
    }
    await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
    await page.waitForTimeout(SETTLE);

    // Same shot pattern every time, so the only variable is the link.
    for (let shot = 0; shot < SHOTS; ++shot) {
      await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
      await page.waitForTimeout(150);
      const p = await player(page);
      const range = Math.hypot(p.position[0], p.position[2]);
      const lift = Math.atan2(0.5 * 9.81 * (range / 60) ** 2, range);
      await page.evaluate(([y, q]) => window.__VIBE_DRIVE__.look(y, q),
        [p.yaw, 0.03 + 0.03 * (shot % 3) + lift]);
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 140 }));
      await page.waitForTimeout(1100);
    }
    await page.waitForTimeout(4000);

    const seen = await city(page);
    const truth = await serverStats();
    rows.push({
      link: shaper.describe(),
      relayed: shaper.stats.toClient,
      dropped: shaper.stats.dropped,
      cliBonds: seen.brokenBonds ?? 0,
      srvBonds: truth.city?.broken_bonds ?? null,
      srvBodies: truth.city?.chunk_bodies ?? null,
      srvAwake: truth.city?.awake_bodies ?? null,
      cliBodies: (seen.chunksAwake ?? 0) + (seen.chunksSettled ?? 0),
      jumps1: seen.poseJumpsOver1m ?? 0,
      jumps4: seen.poseJumpsOver4m ?? 0,
      jumps16: seen.poseJumpsOver16m ?? 0,
      jumpMax: seen.poseJumpMaxM ?? 0,
      topoGaps: seen.topoSeqGaps ?? 0,
      settleRejects: seen.settleRejects ?? 0,
      orphans: seen.orphanedChunks ?? 0,
    });
  } finally {
    if (browser) await browser.close();
    shaper.stop();
  }
}

const pad = (v, n) => String(v).padStart(n);
console.log(`\n${'link'.padEnd(34)} ${'drop%'.padStart(6)} ${'cli/srv bonds'.padStart(14)}`
  + ` ${'>1m'.padStart(6)} ${'>4m'.padStart(6)} ${'>16m'.padStart(6)} ${'max m'.padStart(7)}`
  + ` ${'gaps'.padStart(5)} ${'rejects'.padStart(8)}`);
for (const r of rows) {
  const sent = r.relayed + r.dropped;
  const dropPct = sent > 0 ? ((r.dropped / sent) * 100).toFixed(1) : '0.0';
  const agree = r.srvBonds ? `${((r.cliBonds / r.srvBonds) * 100).toFixed(0)}%` : '?';
  console.log(`${r.link.padEnd(34)} ${pad(dropPct, 6)} ${pad(`${r.cliBonds}/${r.srvBonds ?? '?'} ${agree}`, 14)}`
    + ` ${pad(r.jumps1, 6)} ${pad(r.jumps4, 6)} ${pad(r.jumps16, 6)} ${pad(r.jumpMax.toFixed(1), 7)}`
    + ` ${pad(r.topoGaps, 5)} ${pad(r.settleRejects, 8)}`);
}
console.log('\n>1m/>4m/>16m are streamed pose writes that moved a body further than the'
  + '\nstream can account for: what a player sees as debris teleporting.');
