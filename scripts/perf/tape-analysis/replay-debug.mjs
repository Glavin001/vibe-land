// Loads /cityreplay offline and dumps status text, console and unserved requests (debugging replay-perf.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(fileURLToPath(new URL('../../../client/package.json', import.meta.url)));
const { chromium } = require('playwright');
const [distArg, tapePath, manifestPath] = process.argv.slice(2);
if (!distArg || !tapePath || !manifestPath) {
  console.error('usage: node replay-debug.mjs <distDir> <tape> <manifest>');
  process.exit(2);
}
const dist = path.resolve(distArg);
const tape = fs.readFileSync(tapePath), manifest = fs.readFileSync(manifestPath);
const ORIGIN = 'http://localhost:47999'; // intercepted by page.route; nothing listens here. localhost = secure context (crypto.subtle)
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' };
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 250)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());

  if (url.origin !== ORIGIN) return route.abort();
  if (url.pathname.startsWith('/city-manifest/')) return route.fulfill({ body: manifest, contentType: 'application/octet-stream' });
  if (url.pathname === '/__run/tape.vltape') return route.fulfill({ body: tape, contentType: 'application/octet-stream' });
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { if (path.extname(url.pathname)) return route.fulfill({ status: 404, body: '' }); file = path.join(dist, 'index.html'); }
  return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] ?? 'application/octet-stream' });
});
await page.goto(`${ORIGIN}/cityreplay?src=/__run/tape.vltape`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(60000);
console.log('BODY:', (await page.evaluate(() => document.body.innerText)).slice(0, 4000));
console.log('READY:', await page.evaluate(() => !!window.__VIBE_REPLAY__?.ready?.()));
await browser.close();
