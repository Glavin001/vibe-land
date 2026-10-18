/**
 * Browser QA: join the city, aim, shoot, and photograph the result.
 *
 * The headless runner (scripts/qa.sh) is the authority on what the physics
 * did. This answers the other half, which it cannot: whether any of it
 * reaches the screen. A projectile can be perfectly correct on the server and
 * never drawn -- that happened, because the client learns a dynamic body's
 * shape and size from one metadata packet sent at join, and a body created
 * afterwards had no entry in it.
 *
 * Usage:
 *   node client/e2e/qa-shot.mjs --page https://127.0.0.1:1111 --wt-port 4433 \
 *        --cannonball --look 0.8,0 --shots 3 --frames 120,400,1200 --out /tmp/qa
 *
 *   --page <url>       page origin.                 default https://127.0.0.1:1111
 *   --wt-port <n>      local WebTransport port.     default 4433
 *   --cannonball       fire the heavy ball instead of the rifle
 *   --look <yaw,pitch> absolute aim, radians.       default faceCity
 *   --lookat <x,y,z>   aim at a world point instead
 *   --shots <n>        how many to fire.            default 1
 *   --frames <ms,...>  capture delays after each shot. default 120,400,1500
 *   --out <dir>        where the pngs go.           default ./qa-shots
 *   --settle <ms>      wait before the first shot.  default 9000
 */
import { mkdirSync } from 'node:fs';
import { openCity, city } from './helpers/qaSession.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const SHOTS = Number(arg('shots', 1));
const SETTLE = Number(arg('settle', 9000));
const OUT = arg('out', 'qa-shots');
const FRAMES = arg('frames', '120,400,1500').split(',').map(Number);
const LOOK = arg('look', null);
const LOOKAT = arg('lookat', null);

mkdirSync(OUT, { recursive: true });

// The join handshake lives in the shared helper: every script that rewrote it
// by hand got some part of it wrong, and the failure is a page that loads fine
// and shows an empty world.
const { browser, page } = await openCity({
  page: arg('page', 'https://127.0.0.1:1111'),
  wtPort: arg('wt-port', '4433'),
});

if (flag('cannonball')) {
  await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
  console.log('shot mode: cannonball');
}

await page.waitForTimeout(SETTLE);
if (LOOKAT) {
  const [x, y, z] = LOOKAT.split(',').map(Number);
  await page.evaluate(([a, b, c]) => window.__VIBE_DRIVE__.lookAt(a, b, c), [x, y, z]);
} else if (LOOK) {
  const [yaw, pitch] = LOOK.split(',').map(Number);
  await page.evaluate(([a, b]) => window.__VIBE_DRIVE__.look(a, b), [yaw, pitch]);
} else {
  await page.evaluate(() => window.__VIBE_DRIVE__.faceCity());
}
await page.waitForTimeout(800);

const before = await city(page);
await page.screenshot({ path: `${OUT}/00-before.png` });

for (let shot = 1; shot <= SHOTS; ++shot) {
  await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 120 }));
  for (const [index, delay] of FRAMES.entries()) {
    await page.waitForTimeout(delay);
    await page.screenshot({ path: `${OUT}/${String(shot).padStart(2, '0')}-${index}-${delay}ms.png` });
  }
}

await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/99-after.png` });
const after = await city(page);
console.log(`bonds ${before.brokenBonds ?? 0} -> ${after.brokenBonds ?? 0}`
  + ` | islands ${before.liveIslands ?? 0} -> ${after.liveIslands ?? 0}`
  + ` | drawn ${after.chunksDrawn ?? 0}, hidden ${after.chunksHidden ?? 0}, unplaced ${after.chunksUnplaced ?? 0}`);
console.log(`screenshots in ${OUT}`);
await browser.close();
