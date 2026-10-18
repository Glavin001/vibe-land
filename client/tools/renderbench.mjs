/**
 * Drives /renderbench and prints the frame breakdown, uncapped.
 *
 *   node tools/renderbench.mjs                        # default sweep
 *   node tools/renderbench.mjs --cases "chunks=200000&live=8000"
 *   node tools/renderbench.mjs --label after --out tools/profiles
 *
 * Two flags are load-bearing. `--use-angle=vulkan` keeps Chromium off
 * SwiftShader, which reads 8x slow and measures nothing anyone ships. And
 * `--disable-gpu-vsync` uncaps the frame rate: capped, every desktop run prints
 * 16.67 ms and no change to the renderer is ever visible.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const BASE = arg('url', 'https://127.0.0.1:6006');
const LABEL = arg('label', 'bench');
const OUT_DIR = arg('out', '');
const FRAMES = Number(arg('frames', '240'));
const WARMUP_MS = Number(arg('warmup', '4000'));
const THROTTLE = Number(arg('throttle', '1'));
const VIEWPORT = (arg('viewport', '1280x720')).split('x').map(Number);

const DEFAULT_CASES = [
  'chunks=25000&live=0',
  'chunks=25000&live=3000',
  'chunks=100000&live=0',
  'chunks=100000&live=3000',
  'chunks=100000&live=12000',
  'chunks=250000&live=0',
  'chunks=250000&live=12000',
];
const CASES = arg('cases', '') ? arg('cases', '').split(',') : DEFAULT_CASES;

const GPU_ARGS = [
  '--no-sandbox', '--disable-gpu-sandbox', '--ignore-certificate-errors',
  '--allow-insecure-localhost', '--use-gl=angle', '--use-angle=vulkan',
  '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--disable-gpu-vsync', '--disable-frame-rate-limit',
];

function pct(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const results = [];

const header = `${'case'.padEnd(30)}${'fps'.padStart(7)}${'frameP50'.padStart(10)}${'frameP95'.padStart(10)}`
  + `${'cpu'.padStart(8)}${'gl'.padStart(8)}${'city'.padStart(8)}${'write'.padStart(8)}${'sphere'.padStart(8)}`
  + `${'draws'.padStart(7)}${'subdraws'.padStart(10)}${'tris'.padStart(10)}${'build'.padStart(8)}`;
console.log(header);
console.log('-'.repeat(header.length));

for (const query of CASES) {
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: VIEWPORT[0], height: VIEWPORT[1] },
  });
  page.on('pageerror', (e) => console.log('  PAGEERROR', String(e).slice(0, 200)));
  const cdp = await page.context().newCDPSession(page);
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  await page.goto(`${BASE}/renderbench?${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__VIBE_BENCH__?.ready?.() === true, { timeout: 180_000 });
  // Let the orbit settle and the driver warm its pipeline: the first frames
  // after a 250k-instance build are dominated by first-use uploads.
  await page.waitForTimeout(WARMUP_MS);

  const rows = await page.evaluate(async (count) => {
    const bench = window.__VIBE_BENCH__;
    const out = [];
    await new Promise((resolve) => {
      const tick = () => {
        out.push(bench.frameProfile());
        if (out.length >= count) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return out;
  }, FRAMES);
  const stats = await page.evaluate(() => window.__VIBE_BENCH__.stats());

  const g = (key) => rows.map((r) => r[key] ?? 0);
  const record = {
    case: query,
    fps: 1000 / (g('frameTotalMs').reduce((a, b) => a + b, 0) / rows.length),
    frameP50: pct(g('frameTotalMs'), 0.5),
    frameP95: pct(g('frameTotalMs'), 0.95),
    cpu: pct(g('cpuFrameMs'), 0.5),
    gl: pct(g('glRenderMs'), 0.5),
    city: pct(g('cityFrameMs'), 0.5),
    write: pct(g('dirtyWriteMs'), 0.5),
    sphere: pct(g('sphereMs'), 0.5),
    draws: pct(g('drawCalls'), 0.5),
    tris: pct(g('triangles'), 0.5),
    instanceWrites: pct(g('instanceWrites'), 0.5),
    batches: stats.batches,
    instancedMeshes: stats.instancedMeshes,
    subDraws: stats.subDraws,
    chunks: stats.chunks,
    buildMs: stats.buildMs,
  };
  results.push(record);
  console.log(
    `${query.padEnd(30)}${record.fps.toFixed(1).padStart(7)}${record.frameP50.toFixed(2).padStart(10)}`
    + `${record.frameP95.toFixed(2).padStart(10)}${record.cpu.toFixed(2).padStart(8)}`
    + `${record.gl.toFixed(2).padStart(8)}${record.city.toFixed(2).padStart(8)}`
    + `${record.write.toFixed(2).padStart(8)}${record.sphere.toFixed(2).padStart(8)}`
    + `${String(record.draws).padStart(7)}${String(record.subDraws).padStart(10)}`
    + `${String(record.tris).padStart(10)}${record.buildMs.toFixed(0).padStart(8)}`,
  );
  await page.close();
}

await browser.close();

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${LABEL}.json`);
  fs.writeFileSync(file, JSON.stringify({ label: LABEL, throttle: THROTTLE,
    viewport: VIEWPORT.join('x'), results }, null, 2));
  console.log(`\nwrote ${file}`);
}
