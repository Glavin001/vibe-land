// Reset-focused soak of one live /city server: bring a building down, walk
// the player onto its rubble, and reset the city with the player standing
// there, RESETS times. This is the sequence that crashed the server in
// CapsuleController::move (2026-09-24 21:50 SIGBUS, 22:19 SIGSEGV): the
// player's character controller still held the fragment body it stood on,
// which the reset had freed. soak.mjs walks the player back to spawn before
// each reset; this driver does the opposite on purpose.
//
// Run by scripts/perf/rest-soak/run.sh with DRIVER_JS pointing here:
//   DRIVER_JS=scripts/perf/rest-soak/reset-soak.mjs RESETS=12 \
//     scripts/perf/rest-soak/run.sh <on|off> 3600
// Writes OUT/soak.json: one row per reset with where the player stood, how
// far above the spawn ground that was, and whether the server kept ticking.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const CLIENT_DIR = process.env.CLIENT_DIR ?? '/Users/glavin/Development/vibe-land/client';
const require = createRequire(path.join(CLIENT_DIR, 'package.json'));
const { chromium } = require('playwright');
const { walkTo } = await import(path.join(CLIENT_DIR, 'e2e/mac-demo/nav.mjs'));

const OUT = process.env.OUT;
if (!OUT) throw new Error('OUT is required');
const CLIENT = process.env.CLIENT ?? 'http://localhost:3643';
const API = process.env.API ?? 'http://127.0.0.1:6401';
const MATCH = process.env.MATCH ?? 'city-default';
const RESETS = Number(process.env.RESETS ?? 12);
const MAX_FPS = process.env.MAX_FPS ?? '30';
const LABEL = (process.env.LABEL ?? 'reset').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 20);
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const soak = { label: LABEL, driver: 'reset-soak', startedUnixMs: T0, resetsWanted: RESETS, resets: [], errors: [], status: 'running' };
const write = () => fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify(soak, null, 1));
const log = (what) => console.log(`[t=${((Date.now() - T0) / 1000).toFixed(1)}s] ${what}`);

async function api(pathname, body) {
  const response = await fetch(`${API}${pathname}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} answered ${response.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const serverTick = async () => { try { return (await api(`/match-stats/${MATCH}`)).server_tick; } catch { return null; } };
const cityStats = async () => {
  try {
    const c = (await api(`/match-stats/${MATCH}`)).city || {};
    return { bodies: c.chunk_bodies, awake: c.awake_bodies, sleeping: c.sleeping_bodies, broken: c.broken_bonds };
  } catch { return null; }
};

let browser = null;
async function join() {
  browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const consoleLog = path.join(OUT, 'client-console.log');
  page.on('pageerror', (e) => fs.appendFileSync(consoleLog, `[pageerror] ${String(e).slice(0, 400)}\n`));
  page.on('console', (m) => { if (m.type() === 'error') fs.appendFileSync(consoleLog, `[${m.type()}] ${m.text().slice(0, 400)}\n`); });
  await page.goto(`${CLIENT}/city?maxFps=${MAX_FPS}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 90000 });
  await page.mouse.click(640, 360);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
  await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 240000 });
  return page;
}
const snap = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot());

async function bringDown(page, b) {
  const s = await snap(page);
  const [cx, , cz] = b.centre;
  const dx = s.position[0] - cx, dz = s.position[2] - cz, d = Math.hypot(dx, dz) || 1;
  const stand = 10 + b.radius;
  await walkTo(page, cx + (dx / d) * stand, cz + (dz / d) * stand, { within: 3, timeoutMs: 20000 });
  await page.evaluate(() => window.__VIBE_E2E__.setShotMode('cannonball'));
  for (let i = 0; i < 3; i++) {
    const h = b.bottom + (0.2 + 0.2 * i) * (b.top - b.bottom);
    await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [cx, h, cz]);
    await sleep(200);
    await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 40 }));
    await sleep(800);
  }
  const height = b.top - b.bottom;
  return String(await api(`/city-demolish/${MATCH}`, {
    x: cx, z: cz, radius_m: b.radius + 1, below_y: Math.max(b.bottom, 0) + Math.max(2, Math.min(8, height * 0.3)),
    rounds: 48, jitter: 0.25, per_tick: 8, wedge_deg: 0, heading_deg: 0,
  }));
}

process.on('SIGTERM', async () => { soak.status = 'terminated'; write(); await browser?.close().catch(() => {}); process.exit(2); });
try {
  const all = await api('/city-buildings');
  const page = await join();
  log('player joined');
  await sleep(4000);
  const s0 = await snap(page);
  soak.spawn = s0.position;
  const near = all.filter((b) => b.chunks >= 20)
    .sort((a, b) => Math.hypot(a.centre[0] - s0.position[0], a.centre[2] - s0.position[2])
      - Math.hypot(b.centre[0] - s0.position[0], b.centre[2] - s0.position[2]))
    // The nearest two by default: farther ones were often not reached in time
    // (a first run stood 20-50 m off the pile for half of its resets).
    .slice(0, Number(process.env.BUILDINGS ?? 2));
  soak.buildings = near.map((b) => b.id);
  for (let cycle = 1; cycle <= RESETS; cycle++) {
    const b = near[(cycle - 1) % near.length];
    const row = { cycle, building: b.id, centre: b.centre };
    try {
      row.demolish = await bringDown(page, b);
      await sleep(10000); // collapse, settle; with rest sleep on, 2 s windows
      // Onto the pile. walkTo steps sideways and jumps when blocked, which is
      // what gets a capsule up onto rubble.
      await walkTo(page, b.centre[0], b.centre[2], { within: 1.5, timeoutMs: 25000 });
      await sleep(1500);
      const at = (await snap(page)).position;
      row.player = at;
      row.aboveSpawnGroundM = +(at[1] - s0.position[1]).toFixed(2);
      row.fromCentreM = +Math.hypot(at[0] - b.centre[0], at[2] - b.centre[2]).toFixed(2);
      row.cityBefore = await cityStats();
      row.tickBefore = await serverTick();
      row.resetUnixMs = Date.now();
      row.reset = String(await api(`/city-reset/${MATCH}`, {}));
      // Keep moving through the reset: every tick moves the controller anyway,
      // this also moves it sideways off whatever it stands on.
      for (let i = 0; i < 6; i++) {
        await page.evaluate((st) => window.__VIBE_DRIVE__.move({ forward: 0.6, strafe: st, durationMs: 900 }), i % 2 ? 1 : -1);
        await sleep(1000);
      }
      row.tickAfter = await serverTick();
      await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 120000 });
      await sleep(3000);
      row.tickRebuilt = await serverTick();
      row.serverTicking = row.tickRebuilt != null && row.tickBefore != null && row.tickRebuilt > row.tickBefore;
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 300);
      soak.errors.push(`reset ${cycle}: ${row.error}`);
    }
    soak.resets.push(row);
    write();
    log(`reset ${cycle}/${RESETS} b${b.id}: player ${row.aboveSpawnGroundM} m above spawn ground, ${row.fromCentreM} m from centre; ticks ${row.tickBefore} -> ${row.tickRebuilt}${row.error ? ` ERROR ${row.error}` : ''}`);
    if (row.tickRebuilt == null) break; // the server is gone; run.sh reports it
  }
  soak.endedUnixMs = Date.now();
  soak.status = soak.errors.length ? 'completed-with-errors' : 'ok';
  write();
  await browser.close().catch(() => {});
  log(`done: ${soak.resets.length} resets, ${soak.errors.length} errors`);
  process.exit(0);
} catch (e) {
  soak.status = 'failed';
  soak.errors.push(`driver: ${e?.stack ?? e}`);
  write();
  log(`FAIL ${e?.stack ?? e}`);
  await browser?.close().catch(() => {});
  process.exit(2);
}
