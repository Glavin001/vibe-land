// Functional smoke test, not a graphics/performance benchmark. Graphics
// settings affect only this disposable browser context, never public defaults.
import { chromium } from '../client/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';
const [origin, udpPort, output] = process.argv.slice(2);
if (!origin || !/^\d+$/.test(udpPort ?? '') || !output) throw Error('Expected: local HTTPS origin, local UDP port, output JSON');
const started = Date.now();
const report = { ok: false, profile: 'fast, 480x270, software rendering', publicUdpVerified: false, errors: [] };
let server;
function save() {
  report.elapsedMs = Date.now() - started;
  writeFileSync(output, JSON.stringify(report, null, 2));
}
function killBrowser() {
  const pid = server?.process()?.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
// Bound evaluate(), screenshot-free rendering, and shutdown too. A
// waitForFunction timeout alone left the previous harness hanging for minutes.
const deadline = setTimeout(() => {
  report.ok = false; report.errors.push('Smoke test exceeded 85 seconds');
  save(); killBrowser(); process.exit(1);
}, 85_000);
try {
  server = await chromium.launchServer({ headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
  const browser = await chromium.connect(server.wsEndpoint());
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => report.errors.push(String(e)));
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ tier: 'fast', shadows: '0', ao: '0', cityTextures: 'off', skyIbl: '0', skyDome: '0', dprCap: '1' })) localStorage.setItem(`vibe.render.${key}`, value);
  });
  await page.route('**/session-config*', async route => {
    const response = await route.fetch(); const body = await response.json(); const url = new URL(body.url);
    if (url.pathname !== '/game') throw Error(`Malformed advertised path: ${url.pathname}`);
    report.advertisedUrl = body.url;
    // Hairpin workaround: preserve scheme, path, and certificate pin.
    url.hostname = '127.0.0.1'; url.port = udpPort; body.url = url.toString();
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${origin}/city?portal=true&match=city-default`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 20_000 });
  await page.mouse.click(240, 135);
  await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const c = window.__VIBE_E2E__.snapshot().city;
    return c?.rendered && c.chunksTotal > 0 && c.bootstraps > 0;
  }, null, { timeout: 40_000 });
  const s = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
  report.transport = s.transport; report.city = s.city;
  if (s.city.orphanedChunks || s.city.hashMismatches || report.errors.length) throw Error('Missing chunks, state divergence, or JavaScript errors');
  report.ok = true;
  await browser.close(); await server.close();
} catch (e) {
  report.ok = false; report.errors.push(String(e)); killBrowser();
} finally {
  clearTimeout(deadline); save();
}
console.log(JSON.stringify(report));
process.exit(report.ok ? 0 : 1);
