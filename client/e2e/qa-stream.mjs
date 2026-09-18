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
 *   node client/e2e/qa-stream.mjs --links "0/0/0, 60/20/0.02, 150/40/0.08/0.01"
 *
 *   --links <list>   semicolon separated delay/jitter/loss[/reorder] specs,
 *                    delay and jitter in ms, loss and reorder as fractions
 *   --shots <n>      shots per link.              default 6
 *   --settle <ms>    give up waiting for the city. default 60000
 *   --drain <ms>     give up waiting for the ledger to catch up. default 30000
 *   --unordered      let jitter shuffle packets, which no real link does; kept
 *                    so the pathological case stays reproducible
 *   --api <url>      server stats origin.         default http://127.0.0.1:4017
 *   --match <id>     match id.                    default city-default
 *   --query <s>      query string for /city, e.g. adaptiveBuffer=1
 */
import { openCity, city, player } from './helpers/qaSession.mjs';
import { startShaper } from './helpers/netShaper.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const SHOTS = Number(arg('shots', 6));
const SETTLE = Number(arg('settle', 60000));
const DRAIN = Number(arg('drain', 30000));
const PRESERVE_ORDER = !argv.includes('--unordered');
const LINKS = arg('links', '0/0/0; 40/10/0.005; 90/25/0.02; 180/60/0.08/0.01')
  .split(';').map((s) => s.trim()).filter(Boolean)
  .map((spec) => {
    const [delayMs, jitterMs, loss, reorder] = spec.split('/').map(Number);
    return {
      delayMs: delayMs || 0, jitterMs: jitterMs || 0,
      loss: loss || 0, reorder: reorder || 0,
    };
  });

const serverStats = async () => {
  try {
    const response = await fetch(`${API}/match-stats/${MATCH}`);
    return response.ok ? await response.json() : {};
  } catch { return {}; }
};

/**
 * Rejected destruction ticks, cumulative.
 *
 * Read before and after every link because a stage that has stopped accepting
 * steps looks EXACTLY like a perfect network from here: the city simply never
 * breaks, so client and server agree on zero broken bonds and the run reports
 * 100% agreement. A whole sweep was published that way -- four links scored
 * against a city that had been indestructible since the first reset, with the
 * stage rejecting every tick and the server otherwise reporting a healthy
 * 60 Hz. Comparing two sides of a stream says nothing when neither side has
 * anything to say.
 */
const rejectedTicks = (truth) => truth.spans?.['destruction/native_error_frames']?.v ?? 0;

const reset = async () => {
  try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
};

const rows = [];
for (const link of LINKS) {
  await reset();
  await new Promise((r) => setTimeout(r, 4000));
  const rejectedBefore = rejectedTicks(await serverStats());

  const shaper = await startShaper({
    target: Number(arg('wt-port', 4433)), preserveOrder: PRESERVE_ORDER, ...link,
  });
  let browser;
  try {
    const session = await openCity({
      page: arg('page', 'https://127.0.0.1:1111'),
      wtPort: shaper.port,
      query: arg('query', ''),
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

    // How long the city takes to show up is the measurement, not a constant to
    // wait out. A fixed settle cannot tell "never arrived" from "arrived at
    // t+20s", and reading a too-short one as "never" is how a slow link got
    // reported as a dead one.
    const joinedAt = Date.now();
    let bootMs = null;
    while (Date.now() - joinedAt < SETTLE) {
      const s = await city(page);
      if ((s.bootstraps ?? 0) > 0) { bootMs = Date.now() - joinedAt; break; }
      await page.waitForTimeout(250);
    }
    // Let the world finish arriving before shooting at it.
    await page.waitForTimeout(3000);

    console.log(`${shaper.describe()}: city at ${bootMs === null ? 'never' : `${bootMs} ms`}, firing`);

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
    // Wait for the ledger to CATCH UP, and time it, rather than waiting a fixed
    // few seconds and calling whatever is on screen the answer. The reliable
    // lane can be slow without being broken, and a fixed wait cannot tell those
    // apart -- which is exactly the mistake that produced an earlier "the
    // stream completely fails" claim about a stream that was merely late.
    const drainStarted = Date.now();
    let convergedMs = null;
    while (Date.now() - drainStarted < DRAIN) {
      const truthNow = await serverStats();
      const want = truthNow.city?.broken_bonds ?? 0;
      const have = (await city(page)).brokenBonds ?? 0;
      if (want > 0 && have >= want) { convergedMs = Date.now() - drainStarted; break; }
      await page.waitForTimeout(500);
    }

    const seen = await city(page);
    const shooter = await player(page);
    const truth = await serverStats();
    const rejected = rejectedTicks(truth) - rejectedBefore;
    if (rejected > 0) {
      console.error(`\nthe destruction stage rejected ${rejected} ticks during this link`
        + ` (error bits ${truth.spans?.['destruction/native_error_bits_last']?.v ?? '?'}).`
        + `\nNothing measured past this point is about the network: the city is not`
        + `\nbreaking, so both sides agree on nothing. Restart the server first.`);
      await browser.close();
      shaper.stop();
      process.exit(1);
    }
    rows.push({
      link: shaper.describe(),
      bootMs,
      convergedMs,
      // Whether the trigger actually produced a round. A link that delays the
      // world also delays this harness's own frames, and a run that fired
      // nothing looks exactly like a run whose shots were lost.
      shotsFired: shooter.shotsFired ?? 0,
      lastShot: shooter.lastShot ?? null,
      delayTicks: seen.sampleDelayTicks ?? 0,
      lateTicks: seen.arrivalLatenessPeakTicks ?? 0,
      kbDown: Math.round(shaper.stats.bytesToClient / 1024),
      kbUp: Math.round(shaper.stats.bytesToServer / 1024),
      reordered: shaper.stats.reordered,
      relayed: shaper.stats.toClient,
      relayedUp: shaper.stats.toServer,
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
      drawn1: seen.presentedJumpsOver1m ?? 0,
      drawn4: seen.presentedJumpsOver4m ?? 0,
      drawnMax: seen.presentedJumpMaxM ?? 0,
      topoGaps: seen.topoSeqGaps ?? 0,
      settleRejects: seen.settleRejects ?? 0,
      orphans: seen.orphanedChunks ?? 0,
      bootstraps: seen.bootstraps ?? 0,
      datagrams: seen.datagramsReceived ?? 0,
      wire: seen.wireVersion ?? 0,
      hashChecks: seen.hashChecks ?? 0,
      hashMismatches: seen.hashMismatches ?? 0,
      repairs: seen.structureRepairs ?? 0,
    });
  } finally {
    if (browser) await browser.close();
    shaper.stop();
  }
}

const pad = (v, n) => String(v).padStart(n);
console.log(`\n${'link'.padEnd(34)} ${'drop%'.padStart(6)} ${'boot'.padStart(7)} ${'cli/srv bonds'.padStart(14)}`
  + ` ${'>1m'.padStart(6)} ${'>4m'.padStart(6)} ${'>16m'.padStart(6)} ${'max m'.padStart(7)}`
  + ` ${'per bond'.padStart(9)}`
  + ` ${'drawn >1/>4@max'.padStart(14)}`
  + ` ${'gaps'.padStart(5)} ${'rejects'.padStart(8)}`);
for (const r of rows) {
  // Both directions, on both sides of the ratio. Dividing drops from both by
  // deliveries from one reported 26% on a link configured for 8%.
  const sent = r.relayed + r.relayedUp + r.dropped;
  const dropPct = sent > 0 ? ((r.dropped / sent) * 100).toFixed(1) : '0.0';
  const agree = r.srvBonds ? `${((r.cliBonds / r.srvBonds) * 100).toFixed(0)}%` : '?';
  const boot = r.bootMs === null ? 'never' : `${(r.bootMs / 1000).toFixed(1)}s`;
  // Jumps per hundred broken bonds, because the raw count is not comparable
  // between runs. A collapse is chaotic: the same six shots break 780 bonds on
  // one run and 1,581 on the next, and twice the rubble is twice the chance to
  // see a body step. An A/B read off the raw column will find whatever it wants.
  const perBond = r.srvBonds ? ((r.jumps1 * 100) / r.srvBonds).toFixed(1) : '?';
  console.log(`${r.link.padEnd(34)} ${pad(dropPct, 6)} ${pad(boot, 7)} ${pad(`${r.cliBonds}/${r.srvBonds ?? '?'} ${agree}`, 14)}`
    + ` ${pad(r.jumps1, 6)} ${pad(r.jumps4, 6)} ${pad(r.jumps16, 6)} ${pad(r.jumpMax.toFixed(1), 7)}`
    + ` ${pad(`${perBond}/100`, 9)}`
    + ` ${pad(`${r.drawn1}/${r.drawn4}@${r.drawnMax.toFixed(1)}`, 14)}`
    + ` ${pad(r.topoGaps, 5)} ${pad(r.settleRejects, 8)}`
    + ` | caught up ${r.convergedMs === null ? 'never' : `${(r.convergedMs / 1000).toFixed(1)}s`}`
    + ` | boot ${r.bootstraps} dgrams ${r.datagrams} wire ${r.wire}`
    + ` hash ${r.hashMismatches}/${r.hashChecks} repairs ${r.repairs}`
    + ` | ${r.kbDown} KiB down, ${r.kbUp} KiB up, ${r.reordered} reordered`
    + ` | fired ${r.shotsFired} (${r.lastShot ?? 'none'})`
    + ` | buffer ${r.delayTicks.toFixed(1)} vs late ${r.lateTicks.toFixed(1)} ticks`);
}
console.log('\n>1m/>4m/>16m are RAW streamed pose writes that moved a body further than'
  + '\nthe stream can account for. They are an upper bound on the link\'s roughness,'
  + '\nnot on what a player saw: the presentation pass rewrites every live body once'
  + '\na frame before the renderer composes, so most raw writes never reach a screen.'
  + '\nThe "drawn" column is the one that did -- steps in the presented pose, which'
  + '\nthe interpolator is supposed to make impossible. Read per bond, not raw: how'
  + '\nmuch rubble a run produces varies by a factor of two on identical shots.');
