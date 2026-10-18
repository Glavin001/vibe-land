// Profile the client's main thread over chosen windows of a recorded tape, in
// /cityreplay, headless Chromium on ANGLE/Metal (the city bench's browser).
//
//   CLIENT=http://localhost:3303 node e2e/tape-replay/profile-windows.mjs \
//     --tape <client.vltape> --manifest <manifest-<hash>.bin> --out <dir> \
//     --windows 93.2,162.3,292.2 [--before 3] [--after 2] [--settle 4] [--profile]
//     [--gpu-load N] [--governor] [--repeat N]
//
// Window times are seconds on the tape's recording clock: the `t_s` of the
// city bench's "Worst hitches" table and `t_ms / 1000` of its frames.csv. For
// each window the replay is seeked to `t - before - settle`, played at 1x for
// `settle` s (a seek applies the skipped past in one frame), then measured
// from `t - before` to `t + after`: every frame's renderStats (CPU span, city
// frame, gl.render, ...) and, with --profile, a V8 CPU profile over the same
// span (Chrome DevTools protocol; open the .cpuprofile in DevTools).
//
// Writes <out>/frames-<t>.json per window and <out>/summary.json: CPU p50 /
// p99 / max, frames over 16.7 and 33 ms CPU, and, from the profile, the
// functions with the most self time inside frames whose CPU span exceeded
// 16.7 ms, in busy stretches over 16 ms, and over the whole window. The replay applies packets inside the frame (`player.tick()`),
// where the live client handles them between frames, so a replay frame's CPU
// includes the packet decode a live frame would not.
//
// `--gpu-load N` runs a GPU hog in a second browser (its own GPU process, as
// the city server is its own Metal client) for the whole run: a fullscreen
// quad whose fragment shader loops N times, drawn every frame. Live, the
// server's physics shares the GPU and the client's frames wait on it, which
// is what makes the render governor trim resolution; a replay alone on the
// GPU never does. With the hog the replay's governor trims as it does live.
// /cityreplay holds the governor (a bench shows raw cost); `--governor`
// releases it, as the game runs.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { busyStretches, mergeStretches, topFunctions } from '../helpers/cpuProfile.mjs';
import { startGpuHog } from '../helpers/gpuHog.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const CLIENT = process.env.CLIENT ?? 'http://localhost:3303';
const TAPE = arg('tape');
const MANIFEST = arg('manifest');
const OUT = arg('out');
const WINDOWS = String(arg('windows', '')).split(',').filter(Boolean).map(Number);
const BEFORE_S = Number(arg('before', '3'));
const AFTER_S = Number(arg('after', '2'));
const SETTLE_S = Number(arg('settle', '4'));
const PROFILE = argv.includes('--profile');
const REPEAT = Number(arg('repeat', '1'));
const GPU_LOAD = Number(arg('gpu-load', '0'));
const GOVERNOR = argv.includes('--governor');
if (!TAPE || !MANIFEST || !OUT || WINDOWS.length === 0) {
  throw new Error('usage: profile-windows.mjs --tape <vltape> --manifest <bin> --out <dir> --windows t1,t2,...');
}
fs.mkdirSync(OUT, { recursive: true });
const tape = fs.readFileSync(TAPE);
const manifest = fs.readFileSync(MANIFEST);

const hog = GPU_LOAD > 0 ? await startGpuHog(chromium, GPU_LOAD) : null;
const browser = await chromium.launch({
  args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.route((url) => url.pathname.startsWith('/city-manifest/'), (route) => route.fulfill({ body: manifest, contentType: 'application/octet-stream' }));
await page.route((url) => url.pathname === '/__run/tape.vltape', (route) => route.fulfill({ body: tape, contentType: 'application/octet-stream' }));
await page.goto(`${CLIENT}/cityreplay?src=/__run/tape.vltape`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__VIBE_REPLAY__?.ready(), null, { timeout: 180000 });
await page.evaluate(() => window.__VIBE_REPLAY__.pause());
// The same module instance the page runs: Vite serves each module once per URL.
if (GOVERNOR) {
  await page.evaluate(async () => (await import('/src/app/renderQuality.ts')).setGovernorPaused(false));
}
await page.evaluate(async () => {
  const mod = await import('/src/city/renderStats.ts');
  const stats = mod.renderStats;
  const keys = ['frameTotalMs', 'cpuFrameMs', 'glRenderMs', 'beforeCityMs', 'cityFrameMs', 'sampleMs',
    'dirtyWriteMs', 'sphereMs', 'telemetryMs', 'decodeMs', 'dustEmitMs', 'dustCpuMs', 'dustOccupancyMs',
    'meteorFireMs', 'instanceWrites', 'drawCalls', 'dprScale', 'gpuFrameMs'];
  window.__HITCH__ = { rows: null, keys };
  const loop = () => {
    const h = window.__HITCH__;
    if (h.rows) {
      const row = [performance.now(), window.__VIBE_REPLAY__.tapeTimeMs()];
      for (const k of keys) row.push(stats[k] ?? 0);
      h.rows.push(row);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});

const cdp = await context.newCDPSession(page);
if (PROFILE) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
}

const q = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
const summary = { client: CLIENT, tape: TAPE, windows: [] };
const origin = await page.evaluate(() => window.__VIBE_REPLAY__.originMs());

for (let rep = 0; rep < REPEAT; rep += 1) {
  for (const t of WINDOWS) {
    const startMs = t * 1000 - BEFORE_S * 1000;
    const endMs = t * 1000 + AFTER_S * 1000;
    await page.evaluate(async ([seekMs]) => {
      const r = window.__VIBE_REPLAY__;
      r.pause();
      await r.seek(seekMs);
      r.setSpeed(1);
      r.play();
    }, [startMs - SETTLE_S * 1000 - origin]);
    await page.waitForFunction((ms) => window.__VIBE_REPLAY__.tapeTimeMs() >= ms, startMs, { timeout: 120000, polling: 50 });
    await page.evaluate(() => { window.__HITCH__.rows = []; });
    if (PROFILE) await cdp.send('Profiler.start');
    const perfStart = await page.evaluate(() => performance.now());
    await page.waitForFunction((ms) => window.__VIBE_REPLAY__.tapeTimeMs() >= ms, endMs, { timeout: 120000, polling: 100 });
    const profile = PROFILE ? (await cdp.send('Profiler.stop')).profile : null;
    const { rows, keys } = await page.evaluate(() => {
      const h = window.__HITCH__;
      const out = { rows: h.rows, keys: h.keys };
      h.rows = null;
      return out;
    });
    await page.evaluate(() => window.__VIBE_REPLAY__.pause());
    const frames = rows.map((row) => {
      const o = { perfMs: row[0], tapeMs: row[1] };
      keys.forEach((k, i) => { o[k] = row[i + 2]; });
      return o;
    });
    const tag = `${t.toFixed(2)}${REPEAT > 1 ? `-r${rep}` : ''}`;
    fs.writeFileSync(path.join(OUT, `frames-${tag}.json`), JSON.stringify(frames));
    const cpu = frames.map((f) => f.cpuFrameMs).sort((a, b) => a - b);
    const win = {
      t,
      rep,
      frames: frames.length,
      cpuP50: +q(cpu, 0.5).toFixed(2),
      cpuP99: +q(cpu, 0.99).toFixed(2),
      cpuMax: +(cpu[cpu.length - 1] ?? 0).toFixed(2),
      cpuSum: +cpu.reduce((a, b) => a + b, 0).toFixed(1),
      over16: cpu.filter((c) => c > 16.7).length,
      over33: cpu.filter((c) => c > 33).length,
      dprSteps: frames.filter((f, i) => i > 0 && f.dprScale !== frames[i - 1].dprScale).length,
      dprMin: +Math.min(...frames.map((f) => f.dprScale)).toFixed(3),
      worst: [...frames].sort((a, b) => b.cpuFrameMs - a.cpuFrameMs).slice(0, 5).map((f) => ({
        tapeS: +(f.tapeMs / 1000).toFixed(3), cpu: +f.cpuFrameMs.toFixed(1), city: +f.cityFrameMs.toFixed(1),
        gl: +f.glRenderMs.toFixed(1), before: +f.beforeCityMs.toFixed(1), sample: +f.sampleMs.toFixed(1),
        dirtyWrite: +f.dirtyWriteMs.toFixed(1), dust: +(f.dustEmitMs + f.dustCpuMs).toFixed(1),
      })),
    };
    if (profile) {
      fs.writeFileSync(path.join(OUT, `profile-${tag}.cpuprofile`), JSON.stringify(profile));
      // The profile clock is paired with the page's at the window's start.
      const toPage = (profileMs) => profileMs - profile.startTime / 1000 + perfStart;
      const spans = frames.filter((f) => f.cpuFrameMs > 16.7).map((f) => [f.perfMs - f.cpuFrameMs - 1, f.perfMs]);
      win.inLongFrames = spans.length
        ? topFunctions(profile, (tMs) => spans.some(([a, b]) => toPage(tMs) >= a && toPage(tMs) <= b), 20)
        : null;
      win.stretches = mergeStretches(busyStretches(profile, { minMs: 16 }), 20);
      win.all = topFunctions(profile, () => true, 20);
    }
    summary.windows.push(win);
    console.log(JSON.stringify(win));
  }
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
await browser.close();
if (hog) await hog.close();
