// Plays the tape through /cityreplay at 1x in Chromium (ANGLE/Metal) with NO
// game server running, following the recorded camera, and records every
// frame's rAF delta, CPU span, GPU timer and awake chunks. Compared with the
// frames the live client recorded, this separates client render cost from
// whatever else shared the machine live (the server's GPU physics).
//
// No HTTP server: the built client (vite build output), the manifest and the
// tape are all served by Playwright request routing.
//   node replay-perf.mjs <distDir> <tape> <manifest> <out.json> [width height dpr headless]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Playwright is a client devDependency: resolve it from client/ (repo-relative).
const require = createRequire(fileURLToPath(new URL('../../../client/package.json', import.meta.url)));
const { chromium } = require('playwright');

const [distArg, tapePath, manifestPath, outPath, w = '1512', h = '945', dpr = '2', headless = '1'] = process.argv.slice(2);
if (!distArg || !tapePath || !manifestPath || !outPath) {
  console.error('usage: node replay-perf.mjs <distDir> <tape> <manifest> <out.json> [width height dpr headless]');
  process.exit(2);
}
const dist = path.resolve(distArg);
const tape = fs.readFileSync(tapePath);
const manifest = fs.readFileSync(manifestPath);
const ORIGIN = 'http://localhost:47999'; // intercepted by page.route; nothing listens here. localhost = secure context (crypto.subtle)
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

const browser = await chromium.launch({ headless: headless === '1', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr });
const page = await context.newPage();
const unserved = new Set();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 200)); });
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) { unserved.add(url.origin + url.pathname); return route.abort(); }
  if (url.pathname.startsWith('/city-manifest/')) return route.fulfill({ body: manifest, contentType: 'application/octet-stream' });
  if (url.pathname === '/__run/tape.vltape') return route.fulfill({ body: tape, contentType: 'application/octet-stream' });
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(url.pathname)) { unserved.add(url.pathname); return route.fulfill({ status: 404, body: '' }); }
    file = path.join(dist, 'index.html');
  }
  return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] ?? 'application/octet-stream' });
});
const t0 = Date.now();
await page.goto(`${ORIGIN}/cityreplay?src=/__run/tape.vltape`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__VIBE_REPLAY__?.ready(), null, { timeout: 180000 });
console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
// Warm-up pass (shader compiles, first-use), then the measured pass from the start.
await page.evaluate(async () => {
  const r = window.__VIBE_REPLAY__;
  await r.rewind();
  r.play();
  await new Promise((res) => setTimeout(res, 3000));
  await r.rewind();
  r.pause();
});
const frames = await page.evaluate(async () => {
  const r = window.__VIBE_REPLAY__;
  const e2e = window.__VIBE_E2E__;
  const out = [];
  let last = performance.now();
  let n = 0;
  r.play();
  const dur = r.durationMs();
  await new Promise((resolve) => {
    const tick = (now) => {
      const p = e2e?.frameProfile?.() ?? {};
      let awake = null;
      if (n % 15 === 0) { try { awake = e2e?.snapshot?.().city?.chunksAwake ?? null; } catch { awake = null; } }
      out.push([r.tapeTimeMs(), now - last, p.frameTotalMs ?? 0, p.cpuFrameMs ?? 0, p.gpuFrameMs ?? 0, p.dprScale ?? 1, awake, p.glRenderMs ?? 0]);
      last = now; n += 1;
      if (r.timeMs() >= dur - 5) resolve(); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return out;
});
fs.writeFileSync(outPath, JSON.stringify({ viewport: { w: +w, h: +h, dpr: +dpr, headless: headless === '1' }, columns: ['tape_ms', 'raf_ms', 'frame_total_ms', 'cpu_ms', 'gpu_ms', 'dpr_scale', 'awake', 'gl_render_ms'], frames, unserved: [...unserved].slice(0, 50) }));
console.log(`frames ${frames.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s; unserved ${[...unserved].slice(0, 10).join(' ')}`);
await browser.close();
