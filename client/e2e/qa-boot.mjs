/**
 * Where the seconds go between joining and seeing the city.
 *
 * On loopback the world appears in about half a second. Add 40 ms of one-way
 * delay -- an ordinary link -- and it takes ten times that, which is far more
 * than the extra round trips can account for. This samples both ends of the
 * wire every 250 ms during the join so the shape of the delay is visible:
 * whether bytes trickle in at a rate the window explains, or arrive quickly
 * and then sit unused while the client chews on them.
 *
 *   node client/e2e/qa-boot.mjs --delay 40 --jitter 10
 *   node client/e2e/qa-boot.mjs --delay 0            # the baseline
 *   node client/e2e/qa-boot.mjs --delay 40 --jitter 10 --direction up
 *
 *   --direction both|up|down   which way to degrade. 'down' jitters the data,
 *                              'up' jitters only the acknowledgements, which
 *                              is how you tell a receive problem from a
 *                              sender that has lost its clock.
 */
import { openCity, city } from './helpers/qaSession.mjs';
import { startShaper } from './helpers/netShaper.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const API = arg('api', 'http://127.0.0.1:4017');
const MATCH = arg('match', 'city-default');
const LIMIT = Number(arg('limit', 45000));

try { await fetch(`${API}/city-reset/${MATCH}`, { method: 'POST' }); } catch { /* best effort */ }
await new Promise((r) => setTimeout(r, 4000));

const shaper = await startShaper({
  target: Number(arg('wt-port', 4433)),
  delayMs: Number(arg('delay', 40)),
  jitterMs: Number(arg('jitter', 10)),
  loss: Number(arg('loss', 0)),
  direction: arg('direction', 'both'),
});

const { browser, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  wtPort: shaper.port,
  quiet: true,
});

console.log(`${shaper.describe()}\n`);
console.log(`${'t (ms)'.padStart(7)} ${'KiB down'.padStart(9)} ${'KiB/s'.padStart(8)}`
  + ` ${'chunks'.padStart(7)} ${'boot'.padStart(5)} ${'dgrams'.padStart(7)}`);

const started = Date.now();
let lastBytes = 0;
let lastAt = started;
let booted = null;
while (Date.now() - started < LIMIT) {
  const s = await city(page);
  const now = Date.now();
  const bytes = shaper.stats.bytesToClient;
  const rate = (bytes - lastBytes) / 1024 / Math.max(0.001, (now - lastAt) / 1000);
  console.log(`${String(now - started).padStart(7)} ${String(Math.round(bytes / 1024)).padStart(9)}`
    + ` ${rate.toFixed(0).padStart(8)} ${String(s.chunksTotal ?? 0).padStart(7)}`
    + ` ${String(s.bootstraps ?? 0).padStart(5)} ${String(s.datagramsReceived ?? 0).padStart(7)}`);
  lastBytes = bytes; lastAt = now;
  if ((s.bootstraps ?? 0) > 0) { booted = now - started; break; }
  await page.waitForTimeout(250);
}

const held = shaper.stats;
console.log(`\ncity visible after ${booted === null ? 'never' : `${booted} ms`},`
  + ` ${Math.round(held.bytesToClient / 1024)} KiB down in`
  + ` ${held.toClient} packets`);
console.log(`relay held downstream: mean ${(held.heldSumMs.toClient / Math.max(1, held.toClient)).toFixed(1)} ms,`
  + ` max ${held.heldMaxMs.toClient} ms, out of order ${held.outOfOrder.toClient}`
  + `  (asked for ${held.delayMs} +/- ${held.jitterMs} ms)`);
await browser.close();
shaper.stop();
