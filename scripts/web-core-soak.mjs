// Soak the web /city: headless Chromium on the page's defaults (every shared-core flag on), a
// meteor every 12 s for 5 minutes, sampling the wire 4 stream's counters every 10 s. `--off a,b`
// switches those flags off (`?a=0&b=0`); `--off all` runs the TypeScript path throughout.
//
//   node scripts/web-core-soak.mjs [--url http://localhost:3003] [--api http://127.0.0.1:4001] [--match citypp-websoak2] [--seconds 300] [--off all]
//
// Exits non-zero on a hash mismatch, a decode error, a page error, or a render clock that stalls.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(resolve(root, 'client/package.json'))('playwright');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const url = arg('--url', 'http://localhost:3003');
const api = arg('--api', 'http://127.0.0.1:4001');
const match = arg('--match', `citypp-websoak-${Date.now() % 100000}`);
const seconds = Number(arg('--seconds', '300'));
const FLAGS = ['sharedDecode', 'coreGeometry', 'coreInput', 'corePlayers', 'coreManifest', 'coreGrass', 'coreAudio', 'corePredictor', 'coreStream'];
const offArg = arg('--off', '');
const off = offArg === 'all' ? FLAGS : offArg.split(',').filter(Boolean);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// Failed loads are judged by their URL (the console's copy names none). The shared-grass endpoint
// goes to an optional separate service through Vite's proxy (GRASS_SERVER_PORT), so it may 500.
page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 500 && !/\/match-stats\/[^/]+\/grass/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(`${url}/city?match=${match}${off.map((f) => `&${f}=0`).join('')}`);
await page.waitForFunction(() => window.__VIBE_E2E__, null, { timeout: 60000 });
await page.mouse.click(640, 400);
await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().connected, null, { timeout: 60000 });
await page.evaluate(() => window.__VIBE_E2E__.setDiagnostics(true));

const xs = [-42, -14, 14, 42];
const started = Date.now();
let meteors = 0, nextMeteor = 3000, failed = false, lastTick = -1, stalls = 0, maxLive = 0;
const samples = [];
while (Date.now() - started < seconds * 1000) {
  const t = Date.now() - started;
  if (t >= nextMeteor) {
    const [x, z] = [xs[meteors % 4], xs[Math.floor(meteors / 4) % 4]];
    await fetch(`${api}/city-meteor/${match}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [[x, 8, z]] }) }).catch(() => {});
    meteors += 1;
    nextMeteor += 12000;
  }
  if (samples.length === 0 || t - samples[samples.length - 1].t >= 10000) {
    const s = await page.evaluate(() => {
      const snap = window.__VIBE_E2E__.snapshot();
      const c = snap.city;
      return { fps: snap.debugStats?.fps, connected: snap.connected, tick: c?.perPlayer?.renderTick, live: c?.perPlayer?.liveBodies, checks: c?.hashChecks, mismatches: c?.hashMismatches, decode: c?.perPlayer?.decodeErrors, bootstraps: c?.perPlayer?.bootstraps };
    });
    samples.push({ t, ...s });
    console.log(JSON.stringify({ s: Math.round(t / 1000), meteors, ...s }));
    if (s.tick === lastTick) stalls += 1;
    lastTick = s.tick;
    maxLive = Math.max(maxLive, s.live ?? 0);
    if (s.mismatches > 0 || s.decode > 0 || !s.connected) failed = true;
  }
  await new Promise((r) => setTimeout(r, 250));
}
await browser.close();
const last = samples[samples.length - 1];
const summary = { match, seconds, flagsOff: off, meteors, samples: samples.length, maxLiveBodies: maxLive, hashChecks: last.checks, hashMismatches: last.mismatches, decodeErrors: last.decode, renderStalls: stalls, errors: errors.slice(0, 10), errorCount: errors.length };
console.log(JSON.stringify(summary));
if (failed || stalls > 0 || errors.length > 0 || maxLive === 0) {
  console.error('web-core-soak: FAILED');
  process.exit(1);
}
console.error('web-core-soak: passed');
