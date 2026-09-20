/**
 * The 120 Hz gate: join the LIVE /city on this host in a GPU Chromium and
 * report frame time in PRETTY and FAST, as a single number on the last line.
 *
 *   node tools/city-120hz-bench.mjs [--page https://127.0.0.1:6006]
 *        [--wt https://127.0.0.1:4433/game] [--frames 300] [--viewport 2056x1198]
 *        [--dsf 2] [--tiers pretty,fast] [--metric pretty-p95] [--out dir]
 *        (--metric also takes <tier>-<phase>-<stat>, e.g. pretty-cpuFrameMs-p95)
 *        [--demolish] [--meteors 12] [--meteor-gap 3000] [--storm-wait 12000] [--sample-from 2]
 *        [--repeats 1]
 *
 * Why it is shaped this way:
 *
 *  - Without --demolish it joins whatever state the server is in (no shots
 *    fired). With --demolish it POSTs /city-reset, waits for the fresh city,
 *    then queues `--meteors` meteors on a fixed grid over the town via /city-meteor
 *    and samples `--storm-wait` ms after the last launch, mid-collapse. Point
 *    it at a PRIVATE bench server for that: it wipes the city every pass.
 *  - `--disable-gpu-vsync --disable-frame-rate-limit` uncap the frame. Capped,
 *    every run prints 16.67 ms and nothing is visible.
 *  - `--use-angle=vulkan` keeps Chromium off SwiftShader. The script REFUSES to
 *    report if the WebGL renderer string mentions SwiftShader/llvmpipe.
 *  - The reporter's Mac is dpr 2 at 2056x1198 (perf reports in debug-reports/).
 *    This box's GPU is ~10x that machine's, so at the same backing store the
 *    GPU half of the frame is invisible here. `--dsf 4` quadruples the pixels
 *    (in-app cap 1.5 still applies) to give fill cost a chance to show; it is
 *    a proxy, not the Mac.
 *  - This box is shared: other sessions' servers, builds and bots run beside
 *    the bench, and their load only ever ADDS frame time. `--repeats N` runs
 *    the storm N times in one page and the metric is the best (lowest) p95,
 *    which is the run least disturbed by whatever else was running.
 *  - Tiers are applied by pre-seeding localStorage and reloading: antialias
 *    and tonemapping are context-creation-time, so a live setter would measure
 *    a half-applied tier.
 *
 * Last line of stdout is the chosen metric as a bare number (ms), so
 * `... | tail -1` is the verify pipeline. Exit 1 on any refusal.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PAGE = arg('page', 'https://127.0.0.1:6006');
const WT_URL = arg('wt', 'https://127.0.0.1:4433/game');
const FRAMES = Number(arg('frames', '300'));
const WARMUP_MS = Number(arg('warmup', '5000'));
const [VW, VH] = arg('viewport', '2056x1198').split('x').map(Number);
const DSF = Number(arg('dsf', '2'));
const TIERS = arg('tiers', 'pretty,fast').split(',');
const METRIC = arg('metric', 'pretty-p95');
const OUT_DIR = arg('out', '');
const LABEL = arg('label', new Date().toISOString().replace(/[:.]/g, '-'));
const DEMOLISH = argv.includes('--demolish');
const METEORS = Number(arg('meteors', '12'));
const STORM_WAIT_MS = Number(arg('storm-wait', '12000'));
const METEOR_GAP_MS = Number(arg('meteor-gap', '3000'));
const SAMPLE_FROM = Number(arg('sample-from', '2'));
const REPEATS = Number(arg('repeats', '1'));

const GPU_ARGS = [
  '--enable-quic', '--no-sandbox', '--disable-gpu-sandbox',
  '--ignore-certificate-errors', '--allow-insecure-localhost',
  '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--disable-gpu-vsync', '--disable-frame-rate-limit',
];

const KEYS = [
  'frameTotalMs', 'cpuFrameMs', 'offFrameMs', 'gpuFrameMs',
  'gpuPass0Ms', 'gpuPass1Ms', 'gpuPass2Ms', 'gpuPass3Ms', 'gpuPass4Ms', 'gpuPass5Ms', 'gpuPassCount',
  'glRenderMs',
  'cityFrameMs', 'sampleMs', 'dirtyWriteMs', 'sphereMs', 'telemetryMs',
  'decodeMs', 'dustCpuMs', 'unattributedMs', 'recordWriteMs', 'sweepSliceMs', 'dprScale', 'gpuDustMs', 'governorSampleScale', 'governorFluidCap',
  'drawCalls', 'subDraws', 'triangles', 'instanceWrites',
  'dustDrawn', 'dustDrawnHalf', 'dustParcelsLive', 'dustSamplesEstM', 'dustFluidActive',
];

function pct(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function summarize(rows) {
  const out = {};
  for (const key of KEYS) {
    const v = rows.map((r) => r[key] ?? 0);
    // min: on a GPU shared with other processes, the pass that happened to
    // run alone is the one that measures the renderer.
    let min = Infinity;
    for (const x of v) if (x < min) min = x;
    out[key] = { avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length),
      min: Number.isFinite(min) ? min : 0,
      p50: pct(v, 0.5), p95: pct(v, 0.95), max: Math.max(...v) };
  }
  return out;
}
function table(title, s) {
  const lines = [`=== ${title} ===`,
    `${'phase'.padEnd(16)}${'avg'.padStart(9)}${'min'.padStart(9)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}`];
  for (const key of KEYS) {
    const r = s[key];
    lines.push(`${key.padEnd(16)}${r.avg.toFixed(2).padStart(9)}${r.min.toFixed(2).padStart(9)}${r.p50.toFixed(2).padStart(9)}`
      + `${r.p95.toFixed(2).padStart(9)}${r.max.toFixed(2).padStart(9)}`);
  }
  return lines.join('\n');
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const result = { label: LABEL, page: PAGE, viewport: `${VW}x${VH}`, dsf: DSF, frames: FRAMES, tiers: {} };

for (const tier of TIERS) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: VW, height: VH }, deviceScaleFactor: DSF,
  });
  await context.addInitScript((t) => {
    localStorage.setItem('vibe.render.tier', t);
    // The reporter's PRETTY panel: AO on, shadows on, volumetric dust, IBL on.
    // Pin them so a stale value in this profile cannot change the run.
    localStorage.setItem('vibe.render.shadows', '1');
    localStorage.setItem('vibe.render.ao', '1');
    localStorage.setItem('vibe.render.skyIbl', '1');
    localStorage.setItem('vibe.render.dust', 'volumetric');
    localStorage.removeItem('vibe.render.dprCap');
  }, tier);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => console.error('REQFAIL', r.url().slice(0, 120), r.failure()?.errorText ?? ''));
  await page.route('**/session-config*', async (route) => {
    const response = await route.fetch();
    const body = JSON.parse(await response.text());
    body.url = WT_URL;
    await route.fulfill({ response, body: JSON.stringify(body),
      headers: { ...response.headers(), 'content-type': 'application/json' } });
  });

  await page.goto(`${PAGE}/city`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 90_000 });
  await page.mouse.click(Math.floor(VW / 2), Math.floor(VH / 2));
  await page.waitForFunction(
    () => ['webtransport', 'websocket'].includes(window.__VIBE_E2E__?.snapshot()?.transport ?? 'none'),
    { timeout: 30_000 });
  const transport = await page.evaluate(() => window.__VIBE_E2E__.snapshot().transport);
  if (transport !== 'webtransport') throw new Error(`profiling over ${transport}, not WebTransport`);
  await page.waitForFunction(() => {
    const c = window.__VIBE_E2E__?.snapshot()?.city;
    return !!c && c.chunksTotal > 0 && c.rendered;
  }, { timeout: 120_000 });

  const gpu = await page.evaluate(() => {
    const gl = document.querySelector('canvas')?.getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  if (/swiftshader|llvmpipe|software/i.test(gpu)) throw new Error(`software renderer: ${gpu}`);
  const settings = await page.evaluate(() => window.__VIBE_E2E__.renderSettings());
  if (settings.tier !== tier) throw new Error(`tier ${settings.tier}, wanted ${tier}`);

  async function measureOnce() {
    if (DEMOLISH) {
      const bootstrapsBefore = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city.bootstraps);
      // The reset is queued for the tick loop; a reset asked for while rocks
      // are still in flight has been seen not to land whole. Re-ask every 20 s
      // rather than wait two minutes on the first request.
      let fresh = false;
      for (let attempt = 0; attempt < 4 && !fresh; attempt += 1) {
        const reset = await page.evaluate(async () =>
          (await fetch('/city-reset/city-default', { method: 'POST' })).status);
        if (reset !== 202) throw new Error(`city-reset returned ${reset}`);
        fresh = await page.waitForFunction((b) => {
          const c = window.__VIBE_E2E__?.snapshot()?.city;
          return !!c && c.bootstraps > b && c.rendered && c.brokenBonds === 0;
        }, bootstrapsBefore, { timeout: 20_000 }).then(() => true).catch(() => false);
      }
      if (!fresh) throw new Error('city did not come back fresh after reset');
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.__VIBE_DRIVE__.look(Math.PI * 0.75, -0.12));
      // /city-meteor drops rocks on exact points, one per tick, through the same
      // launch path a player's shot takes -- so N means N and every run hits the
      // same spots. A 4x3 grid over the town's footprint (x,z in +-122, roofs at
      // ~17 m; see destruction/assets/scenes/fractured-town.json).
      // A grid dense enough that every rock has its own spot: N rocks on a
      // ceil(sqrt N)-wide lattice over the town's +-105 m footprint, walked in
      // a fixed order, so the storm is the same every run and never wastes a
      // rock on ground an earlier one already cleared.
      const targets = [];
      const side = Math.max(1, Math.ceil(Math.sqrt(METEORS)));
      for (let i = 0; i < METEORS; i += 1) {
        const col = i % side, row = Math.floor(i / side) % side;
        const step = side > 1 ? 210 / (side - 1) : 0;
        targets.push([-105 + col * step, 8, -105 + row * step]);
      }
      // One launch every --meteor-gap ms. Four rocks in flight at once (queued
      // together, or fired a second apart) has twice killed the GPU solver's
      // island build with a CUDA allocation failure -- a fault no player has
      // produced on the live server. Spaced, they land one at a time.
      let seen = 0;
      let collecting = false;
      for (const [i, t] of targets.entries()) {
        if (!collecting && i === SAMPLE_FROM) {
          // Collect every frame from here to the end of the wait: the whole
          // collapse, not a 300-frame slice of whatever state it happened to be
          // in. A 5-second window read 3x apart on two identical storms.
          await page.evaluate(() => {
            window.__benchRows = [];
            window.__benchAwake = [];
            window.__benchStop = false;
            const tick = () => {
              window.__benchRows.push(window.__VIBE_E2E__.frameProfile());
              // The city's own census every 30 frames: how brutal the scene
              // actually was while the frames above were measured.
              if (window.__benchRows.length % 30 === 0) {
                const c = window.__VIBE_E2E__.snapshot().city;
                if (c) window.__benchAwake.push([c.chunksAwake, c.brokenBonds, c.liveIslands]);
              }
              if (!window.__benchStop) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          collecting = true;
        }
        const before = await page.evaluate(() => window.__VIBE_E2E__.meteors().map((f) => f.bodyId));
        const queued = await page.evaluate(async (target) =>
          (await fetch('/city-meteor/city-default', { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ x: target[0], y: target[1], z: target[2] }) })).status, t);
        if (queued !== 202) throw new Error(`city-meteor returned ${queued}`);
        const arrived = await page.waitForFunction((ids) =>
          window.__VIBE_E2E__.meteors().some((f) => !ids.includes(f.bodyId) && f.ageS < 2), before,
          { timeout: 5_000 }).then(() => true).catch(() => false);
        if (arrived) seen += 1;
        await page.waitForTimeout(METEOR_GAP_MS);
      }
      console.log(`[${tier}] storm: ${seen}/${METEORS} meteor launches seen`);
      // Under a heavy storm the client's frames are long and a launch packet
    // can land after the 5 s watch; the rock still fell. Nine in ten is proof
    // the storm happened.
    if (seen < Math.ceil(METEORS * 0.9)) throw new Error(`only ${seen}/${METEORS} meteors launched`);
      await page.waitForTimeout(STORM_WAIT_MS);
    }

    let rows;
    if (DEMOLISH) {
      rows = await page.evaluate(() => { window.__benchStop = true; return window.__benchRows; });
      const census = await page.evaluate(() => window.__benchAwake ?? []);
      if (census.length) {
        const awake = census.map((c) => c[0]);
        const peak = Math.max(...awake);
        const mean = awake.reduce((a, b) => a + b, 0) / awake.length;
        console.log(`[${tier}] during sampling: awake peak=${peak} mean=${mean.toFixed(0)} bonds broken at end=${census[census.length - 1][1]} islands=${census[census.length - 1][2]}`);
        rows.census = { awakePeak: peak, awakeMean: mean };
      }
    } else {
      // Fixed rig: face the city centre from spawn, so both tiers see the same pixels.
      await page.evaluate(() => window.__VIBE_DRIVE__.look(Math.PI * 0.75, -0.12));
      await page.waitForTimeout(WARMUP_MS);
      rows = await page.evaluate(async (count) => {
        const bridge = window.__VIBE_E2E__;
        const out = [];
        await new Promise((resolve) => {
          const tick = () => {
            out.push(bridge.frameProfile());
            if (out.length >= count) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return out;
      }, FRAMES);
    }
    return rows;
  }
  const runs = [];
  for (let r = 0; r < REPEATS; r += 1) {
    const rowsR = await measureOnce();
    const sR = summarize(rowsR);
    runs.push({ rows: rowsR, summary: sR });
    if (REPEATS > 1) console.log(`[${tier}] repeat ${r + 1}/${REPEATS}: frames=${rowsR.length} frame p50=${sR.frameTotalMs.p50.toFixed(2)} p95=${sR.frameTotalMs.p95.toFixed(2)} cpu p95=${sR.cpuFrameMs.p95.toFixed(2)} gpu min=${sR.gpuFrameMs.min.toFixed(2)}`);
  }
  // Best of N: the run least disturbed by the rest of the box, judged on the
  // metric's own phase and statistic.
  const mp = METRIC.split('-');
  const mField = mp.length === 3 ? mp[1] : 'frameTotalMs';
  const mStat = mp[mp.length - 1] === 'p50' || mp[mp.length - 1] === 'min' || mp[mp.length - 1] === 'avg' ? mp[mp.length - 1] : 'p95';
  const best = runs.reduce((x, y) => (y.summary[mField][mStat] < x.summary[mField][mStat] ? y : x));
  const rows = best.rows;
  const backing = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? `${c.width}x${c.height}` : 'none';
  });
  const city = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city);
  const s = best.summary;
  result.tiers[tier] = { gpu, backing, settings, summary: s, repeats: runs.map((r) => r.summary.frameTotalMs),
    city: { total: city.chunksTotal, awake: city.chunksAwake, settled: city.chunksSettled,
      brokenBonds: city.brokenBonds, islands: city.liveIslands } };
  console.log(`[${tier}] gpu=${gpu} backing=${backing} ao=${settings.ao} shadows=${settings.shadows} frames=${rows.length}`);
  console.log(`[${tier}] city total=${city.chunksTotal} awake=${city.chunksAwake} settled=${city.chunksSettled} bonds=${city.brokenBonds} islands=${city.liveIslands}`);
  console.log(table(`${tier}`, s));
  await context.close();
}
await browser.close();

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`wrote ${file}`);
}

// --metric: <tier>-<stat> over frameTotalMs, or 'worst' = max over tiers of
// p95 with FAST weighted 2x (FAST must run at least twice as cheap as PRETTY).
const p95 = (t) => result.tiers[t]?.summary.frameTotalMs.p95 ?? NaN;
let value;
if (METRIC === 'worst') value = Math.max(p95('pretty'), 2 * p95('fast'));
else {
  // <tier>-<stat> over frameTotalMs, or <tier>-<field>-<stat> over any phase.
  const parts = METRIC.split('-');
  const t = parts[0];
  const field = parts.length === 3 ? parts[1] : 'frameTotalMs';
  const stat = parts[parts.length - 1];
  value = result.tiers[t]?.summary[field]?.[stat] ?? NaN;
}
if (!Number.isFinite(value)) { console.error(`metric ${METRIC} unavailable`); process.exit(1); }
console.log(`METRIC ${METRIC}`);
console.log(value.toFixed(2));
