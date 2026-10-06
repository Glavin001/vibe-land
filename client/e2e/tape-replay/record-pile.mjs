// Record the meteor-felled city and its aftermath as a paired session: a
// client tape to fly around in on /cityreplay, and the server's own encoder
// tape (every awake body's pose and velocity, every settle and wake, per
// tick) to analyse.
//
//   CLIENT=http://localhost:3513 API=http://127.0.0.1:4511 REPORTS_DIR=... \
//     node e2e/tape-replay/record-pile.mjs <outDir> [seconds] [meteors]
//
// The player stands at the spawn ring looking into the city. Writes into
// <outDir>: header.json, tape.vltape, the city manifest, and bundle/ (the
// paired server capture).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const CLIENT = process.env.CLIENT ?? 'http://localhost:3513';
const API = process.env.API ?? 'http://127.0.0.1:4511';
const REPORTS_DIR = process.env.REPORTS_DIR;
const MATCH = process.env.MATCH ?? 'city-default';
const OUT = process.argv[2];
const SECONDS = Number(process.argv[3] ?? 150);
const METEORS = Number(process.argv[4] ?? 50);
if (!OUT || !REPORTS_DIR) throw new Error('usage: REPORTS_DIR=... record-pile.mjs <outDir> [seconds] [meteors]');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const mark = (what) => console.log(`[t=${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

const browser = await chromium.launch({
  args: ['--ignore-certificate-errors', '--enable-quic', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(`${CLIENT}/city`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60000 });
await page.mouse.click(640, 360);
await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 180000 });
await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 300000 });
mark('joined, city loaded');
await page.evaluate(() => window.__VIBE_DRIVE__.lookAt(0, 8, 0));
await sleep(3000);

const recording = page.evaluate(
  ([s]) => window.__VIBE_E2E__.recordTape(s, { upload: true, paired: true }),
  [SECONDS],
);
await sleep(2000);

const buildings = await (await fetch(`${API}/city-buildings`)).json();
const list = Array.isArray(buildings) ? buildings : buildings.buildings;
mark(`${list.length} buildings; ${METEORS} meteors, 0.3 s apart`);
for (let i = 0; i < METEORS; i += 1) {
  const [x, y, z] = list[i % list.length].centre;
  await fetch(`${API}/city-meteor/${MATCH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x, y, z }),
  });
  await sleep(300);
}
mark('meteors launched; recording the aftermath');

const header = await recording;
mark(`tape: ${JSON.stringify(header).slice(0, 300)}`);
fs.writeFileSync(path.join(OUT, 'header.json'), JSON.stringify(header, null, 2));
const manifest = await fetch(`${API}/city-manifest/${header.manifestHash}`);
fs.writeFileSync(path.join(OUT, `manifest-${header.manifestHash}.bin`), Buffer.from(await manifest.arrayBuffer()));
if (header.uploadFolder) {
  const from = path.join(REPORTS_DIR, header.uploadFolder);
  fs.cpSync(from, path.join(OUT, 'bundle'), { recursive: true });
  const tape = ['client.vltape', 'city.vltape'].map((f) => path.join(from, f)).find((f) => fs.existsSync(f));
  if (tape) fs.copyFileSync(tape, path.join(OUT, 'tape.vltape'));
  mark(`bundle ${from} copied (paired ${header.uploadPaired})`);
} else {
  mark('upload failed');
}
await context.close();
await browser.close();
