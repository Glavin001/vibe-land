/**
 * Standalone client frame profiler for /city.
 *
 * The Playwright spec (e2e/specs/city-frame-profile.spec.ts) asserts structural
 * invariants; this one exists to *compare builds*. It samples the same bridge
 * counters but reports the full distribution, holds the camera on a fixed rig
 * so two runs see the same pixels, and writes JSON so a before/after diff is a
 * file compare rather than a squint at two console dumps.
 *
 *   node tools/frame-profile.mjs --label baseline [--url https://127.0.0.1:6006]
 *                                [--frames 300] [--demolish] [--out dir]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const has = (name) => argv.includes(`--${name}`);

const LABEL = arg('label', 'run');
const BASE = arg('url', 'https://127.0.0.1:6006');
const FRAMES = Number(arg('frames', '300'));
const WT_URL = arg('wt', 'https://127.0.0.1:4434/game');
const OUT_DIR = arg('out', path.resolve('tools/profiles'));

// Same flags the e2e config uses. Without them Chromium picks SwiftShader even
// on this box and every millisecond below measures software rasterisation.
const GPU_ARGS = [
  '--enable-quic', '--no-sandbox', '--disable-gpu-sandbox',
  '--ignore-certificate-errors', '--allow-insecure-localhost',
  '--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan',
  '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
];

const KEYS = [
  'frameTotalMs', 'cpuFrameMs', 'offFrameMs', 'unattributedMs',
  'glRenderMs', 'beforeCityMs', 'cityFrameMs',
  'sampleMs', 'dirtyWriteMs', 'sphereMs', 'telemetryMs', 'debugE2eMs', 'decodeMs',
  'instanceWrites', 'drawCalls', 'triangles', 'chunksHidden', 'chunksUnresolved',
];

function pct(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(profiles) {
  const out = {};
  for (const key of KEYS) {
    const v = profiles.map((p) => p[key] ?? 0);
    out[key] = {
      avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length),
      p50: pct(v, 0.5),
      p95: pct(v, 0.95),
      max: Math.max(...v),
    };
  }
  return out;
}

function table(title, s) {
  const lines = [`\n=== ${title} ===`,
    `${'phase'.padEnd(18)}${'avg'.padStart(10)}${'p50'.padStart(10)}${'p95'.padStart(10)}${'max'.padStart(10)}`];
  for (const key of KEYS) {
    const r = s[key];
    lines.push(`${key.padEnd(18)}${r.avg.toFixed(2).padStart(10)}${r.p50.toFixed(2).padStart(10)}`
      + `${r.p95.toFixed(2).padStart(10)}${r.max.toFixed(2).padStart(10)}`);
  }
  return lines.join('\n');
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));

// The server advertises its PUBLIC WebTransport URL; a runner on this host
// cannot hairpin UDP back through the NAT, and the silent WebSocket fallback
// would profile a transport no player uses.
await page.route('**/session-config*', async (route) => {
  const response = await route.fetch();
  const body = JSON.parse(await response.text());
  body.url = WT_URL;
  await route.fulfill({ response, body: JSON.stringify(body),
    headers: { ...response.headers(), 'content-type': 'application/json' } });
});

await page.goto(`${BASE}/city`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, { timeout: 30_000 });
await page.mouse.click(640, 360);
await page.waitForFunction(
  () => ['webtransport', 'websocket'].includes(window.__VIBE_E2E__?.snapshot()?.transport ?? 'none'),
  { timeout: 30_000 });
const transport = await page.evaluate(() => window.__VIBE_E2E__.snapshot().transport);
if (transport !== 'webtransport') throw new Error(`profiling over ${transport}, not WebTransport`);

await page.waitForFunction(() => {
  const c = window.__VIBE_E2E__?.snapshot()?.city;
  return !!c && c.chunksTotal > 0 && c.rendered;
}, { timeout: 90_000 });
console.log(`[${LABEL}] rendered; transport=${transport}`);

// Fixed camera rig: face the city centre from the spawn. Two runs must see the
// same pixels or the fill-bound half of the frame is not comparable.
await page.evaluate(() => window.__VIBE_DRIVE__.look(Math.PI * 0.75, -0.12));
await page.waitForTimeout(4000);

async function sample(frames) {
  return page.evaluate(async (count) => {
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
  }, frames);
}

const result = { label: LABEL, url: BASE, frames: FRAMES, phases: {} };

const rest = await sample(FRAMES);
result.phases.rest = summarize(rest);
result.cityAtRest = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city);
console.log(table(`${LABEL} — at rest`, result.phases.rest));
console.log(`[city] total=${result.cityAtRest.chunksTotal} awake=${result.cityAtRest.chunksAwake} `
  + `settled=${result.cityAtRest.chunksSettled} bonds=${result.cityAtRest.brokenBonds} `
  + `islands=${result.cityAtRest.liveIslands}`);

if (has('demolish')) {
  const hash = result.cityAtRest.manifestHash;
  const targets = await page.evaluate(async (h) => {
    const m = await (await fetch(`/city-manifest/${h}`)).json();
    return m.structures
      .map((s) => ({ n: s.chunks.length, pos: s.worldPosition,
        top: Math.max(...s.chunks.map((c) => c.centroid[1])) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((s) => [s.pos[0], (s.pos[1] + s.top) * 0.35, s.pos[2]]);
  }, hash);
  for (const t of targets) {
    for (let i = 0; i < 10; i += 1) {
      await page.evaluate(async (target) => {
        const s = window.__VIBE_E2E__.snapshot();
        const dx = target[0] - s.position[0];
        const dy = target[1] - (s.position[1] + 0.8);
        const dz = target[2] - s.position[2];
        const horizontal = Math.hypot(dx, dz);
        window.__VIBE_DRIVE__.look(Math.atan2(dx, dz), Math.atan2(dy, Math.max(1e-4, horizontal)));
        await new Promise((r) => setTimeout(r, 120));
        window.__VIBE_DRIVE__.fire({ holdMs: 120 });
      }, t);
      await page.waitForTimeout(220);
    }
  }
  const during = await sample(FRAMES);
  result.phases.demolition = summarize(during);
  result.cityDuring = await page.evaluate(() => window.__VIBE_E2E__.snapshot().city);
  console.log(table(`${LABEL} — under demolition`, result.phases.demolition));
  console.log(`[city] awake=${result.cityDuring.chunksAwake} bonds=${result.cityDuring.brokenBonds} `
    + `islands=${result.cityDuring.liveIslands}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${LABEL}.json`);
fs.writeFileSync(file, JSON.stringify(result, null, 2));
console.log(`\nwrote ${file}`);
await browser.close();
