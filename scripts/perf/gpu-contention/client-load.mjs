// A real browser client as a GPU load: plays the 2026-09-24 session tape
// through /cityreplay in headless Chromium (ANGLE/Metal), following the
// recorded camera, with no game server, so the page renders the destruction
// the user watched while perf_bench runs beside it. Records every frame.
//
// Run by ab.sh, not by hand. Environment:
//   DIST      built client (vite build output)
//   TAPE      the session's client.vltape
//   MANIFEST  city manifest named by the tape header's manifestHash
//   OUT       output JSON
//   W H DPR   viewport CSS size and device scale factor (default 2844 2275 0.9,
//             the user's window from the session's debug reports)
//   MAXFPS    appended as ?maxFps=N (the opt-in client cap); empty = none
//   UNCAPPED  1 = Chromium without its frame limit (--disable-frame-rate-limit;
//             headless pacing is otherwise ~120 Hz here, measured)
//   START_MS  tape time to start from (default 40000: after the first meteors,
//             when the city is rubble and the render load is highest)
//   END_MS    tape time to loop back at (default 86000)
//   READY     file to create once warmed up and playing at START_MS
//   STOP      file whose existence ends the run
//   MAX_S     hard stop (default 240)
//   LS        JSON object of localStorage entries set before the page loads,
//             e.g. {"vibe.render.dprCap":"0.54"} (the player's render settings)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../../client/package.json', import.meta.url)));
const { chromium } = require('playwright');

const env = process.env;
const dist = path.resolve(env.DIST);
const tape = fs.readFileSync(env.TAPE);
const manifest = fs.readFileSync(env.MANIFEST);
const OUT = env.OUT;
const W = Number(env.W ?? 2844), H = Number(env.H ?? 2275), DPR = Number(env.DPR ?? 0.9);
const MAXFPS = env.MAXFPS ?? '';
const UNCAPPED = env.UNCAPPED === '1';
const START_MS = Number(env.START_MS ?? 40000), END_MS = Number(env.END_MS ?? 86000);
const MAX_S = Number(env.MAX_S ?? 240);
const ORIGIN = 'http://localhost:47999'; // served by page.route; nothing listens here
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const log = (...a) => console.log(`[client-load ${new Date().toISOString().slice(11, 23)}]`, ...a);

const args = ['--use-angle=metal', '--ignore-gpu-blocklist'];
if (UNCAPPED) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
const browser = await chromium.launch({ headless: true, args });
const stopAll = async (code) => { await browser.close().catch(() => {}); process.exit(code); };
setTimeout(() => { log('MAX_S reached'); void stopAll(3); }, MAX_S * 1000).unref();
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
if (env.LS) {
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, JSON.parse(env.LS));
}
const page = await context.newPage();
page.on('pageerror', (e) => log('[pageerror]', String(e).slice(0, 300)));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN) return route.abort();
  if (url.pathname.startsWith('/city-manifest/')) return route.fulfill({ body: manifest, contentType: 'application/octet-stream' });
  if (url.pathname === '/__run/tape.vltape') return route.fulfill({ body: tape, contentType: 'application/octet-stream' });
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(url.pathname)) return route.fulfill({ status: 404, body: '' });
    file = path.join(dist, 'index.html');
  }
  return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] ?? 'application/octet-stream' });
});
const query = new URLSearchParams({ src: '/__run/tape.vltape' });
if (MAXFPS) query.set('maxFps', MAXFPS);
const t0 = Date.now();
await page.goto(`${ORIGIN}/cityreplay?${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__VIBE_REPLAY__?.ready(), null, { timeout: 180000 });
const info = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  const c = document.querySelector('[data-testid="replay-canvas"] canvas') ?? document.querySelector('canvas');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, dpr: devicePixelRatio,
    canvas: c ? [c.width, c.height] : null, cap: window.__VIBE_FRAME_CAP__?.fps ?? null };
});
log(`ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(info));

// Warm-up (shader compiles, first use) at the start point, then play from it.
await page.evaluate(async ({ start }) => {
  const r = window.__VIBE_REPLAY__;
  await r.seek(r.originMs() + start);
  r.play();
  await new Promise((res) => setTimeout(res, 4000));
  r.pause();
  await r.seek(r.originMs() + start);
}, { start: START_MS });

// Clock pairing: page performance.now() against unix time. analyse.py maps unix
// time to the bench markers' CLOCK_UPTIME_RAW with the pair ab.sh writes to
// clock.txt. (hostMonoMs is node's hrtime, which is NOT that clock; kept for reference.)
const pair = async () => {
  const hr0 = process.hrtime.bigint();
  const p = await page.evaluate(() => ({ now: performance.now(), origin: performance.timeOrigin }));
  const hr1 = process.hrtime.bigint();
  return { pagePerfMs: p.now, pageUnixMs: p.origin + p.now, hostMonoMs: Number((hr0 + hr1) / 2n) / 1e6 };
};
const clockStart = await pair();

await page.evaluate(({ start, end }) => {
  const r = window.__VIBE_REPLAY__;
  const e2e = window.__VIBE_E2E__;
  const rec = { frames: [], loops: 0, stop: false };
  window.__LOAD_REC__ = rec;
  r.play();
  let seeking = false;
  const tick = (now) => {
    if (rec.stop) return;
    const p = e2e?.frameProfile?.() ?? {};
    rec.frames.push([now, p.frameTotalMs ?? 0, p.cpuFrameMs ?? 0, p.gpuFrameMs ?? 0, p.dprScale ?? 1, r.tapeTimeMs()]);
    if (!seeking && r.tapeTimeMs() >= end) {
      seeking = true;
      rec.loops += 1;
      void r.seek(r.originMs() + start).then(() => { seeking = false; });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { start: START_MS, end: END_MS });
if (env.READY) fs.writeFileSync(env.READY, `${Date.now()}\n`);
log('playing; READY written');

while (!(env.STOP && fs.existsSync(env.STOP))) await new Promise((r) => setTimeout(r, 200));
const clockEnd = await pair();
const rec = await page.evaluate(() => {
  const rec = window.__LOAD_REC__;
  rec.stop = true;
  const cap = window.__VIBE_FRAME_CAP__ ?? null;
  return { frames: rec.frames, loops: rec.loops, cap: cap ? { fps: cap.fps, rendered: cap.rendered, skipped: cap.skipped, renderedAtMs: cap.renderedAtMs } : null };
});
fs.writeFileSync(OUT, JSON.stringify({
  viewport: { w: W, h: H, dpr: DPR }, localStorage: env.LS ? JSON.parse(env.LS) : null, maxFps: MAXFPS || null, uncapped: UNCAPPED, startMs: START_MS, endMs: END_MS,
  info, clockStart, clockEnd, loops: rec.loops, cap: rec.cap,
  columns: ['perf_ms', 'frame_total_ms', 'cpu_ms', 'gpu_ms', 'dpr_scale', 'tape_ms'], frames: rec.frames,
}));
log(`stopped: ${rec.frames.length} rAF, loops ${rec.loops}${rec.cap ? `, cap rendered ${rec.cap.rendered}` : ''}`);
await stopAll(0);
