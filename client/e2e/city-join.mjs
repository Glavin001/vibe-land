// Headless player for automated runs: join /city and stay in it.
//
// The city match exists only while a player is in it, so a server-side
// scenario (scripts/vl perf scenario) needs one. Joins the way
// city-play-qa.mjs does (headless Chromium, software GL, the FAST render
// profile), prints "joined <playerId>" once the city has rendered, then idles
// until SECONDS have passed (0: until killed). Exits 1 if it cannot join.
//
//   node e2e/city-join.mjs <client origin> <api origin> [seconds] [match]
import { chromium } from '@playwright/test';

const [origin, api, secondsArg = '0', MATCH = 'city-default'] = process.argv.slice(2);
if (!origin || !api) {
  console.error('usage: city-join.mjs <client origin> <api origin> [seconds] [match]');
  process.exit(2);
}
const seconds = Number(secondsArg);
// Playwright closes the browser on SIGTERM by default; this script's own
// handler must run first to file the final report.
const browser = await chromium.launch({ headless: true, handleSIGTERM: false, handleSIGINT: false,
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
let page;
let joined = false;
// End every run with the client's own debug report (client.json: flicker
// rings, hotspot, frame profile) so a reproduction can compare what the
// client drew; the server adds its repro bundle beside it.
const stop = async (code) => {
  if (joined && page) {
    const folder = await Promise.race([
      page.evaluate((m) => window.__VIBE_E2E__.sendReport?.(m), MATCH).catch((e) => `report failed: ${e}`),
      new Promise((r) => setTimeout(() => r('report timed out'), 8000)),
    ]);
    console.log(`final report ${folder}`);
  }
  await browser.close().catch(() => {});
  process.exit(code);
};
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
try {
  page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => console.error(`pageerror: ${String(e).slice(0, 300)}`));
  await page.addInitScript(() => {
    for (const [k, v] of Object.entries({ tier: 'fast', shadows: '0', ao: '0', cityTextures: 'off', skyIbl: '0', skyDome: '0', dprCap: '1' }))
      localStorage.setItem(`vibe.render.${k}`, v);
  });
  await page.goto(`${origin}/city?portal=true&match=${MATCH}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60_000 });
  await page.mouse.click(320, 180);
  await page.waitForFunction(() => {
    const s = window.__VIBE_E2E__.snapshot();
    return s.connected && s.playerId > 0 && s.city?.rendered && s.city.chunksTotal > 0;
  }, null, { timeout: 120_000 });
  const id = await page.evaluate(() => window.__VIBE_E2E__.snapshot().playerId);
  console.log(`joined ${id}`);
  joined = true;
  if (seconds > 0) {
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await stop(0);
  }
} catch (error) {
  console.error(`city-join failed: ${String(error).slice(0, 500)}`);
  await stop(1);
}
