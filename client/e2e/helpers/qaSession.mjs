/**
 * Join the city from a plain node script, correctly.
 *
 * The TypeScript helpers beside this file serve Playwright *tests*; ad-hoc QA
 * scripts are .mjs and could not use them, so each one grew its own copy of
 * this handshake and each copy got something wrong. The failures are silent
 * and expensive: without the session-config rewrite the page appears to load
 * and the world is simply empty, and `waitUntil: 'load'` never resolves on a
 * page that holds a long-lived connection.
 *
 *   import { openCity } from './helpers/qaSession.mjs';
 *   const { browser, page } = await openCity({ wtPort: 4433 });
 */
import { chromium } from 'playwright';

/**
 * @param {object} [options]
 * @param {string} [options.page]     page origin, default https://127.0.0.1:1111
 * @param {string|number} [options.wtPort]  local WebTransport port, default 4433
 * @param {{width:number,height:number}} [options.viewport]
 * @param {boolean} [options.quiet]   suppress the connection line
 */
export async function openCity(options = {}) {
  const origin = options.page ?? 'https://127.0.0.1:1111';
  const wtPort = String(options.wtPort ?? 4433);
  const viewport = options.viewport ?? { width: 1280, height: 800 };

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  // Rewrite only host:port of the advertised WebTransport URL, keeping its
  // path. Replacing the whole URL would repair a malformed one, and the run
  // would then pass against a server no real client can reach.
  await page.route('**/session-config*', async (route) => {
    const response = await route.fetch();
    const body = JSON.parse(await response.text());
    const url = new URL(body.url);
    url.hostname = '127.0.0.1';
    url.port = wtPort;
    body.url = url.toString();
    await route.fulfill({
      response,
      body: JSON.stringify(body),
      headers: { ...response.headers(), 'content-type': 'application/json' },
    });
  });

  // domcontentloaded, not load: the page keeps a connection open and 'load'
  // may never fire.
  await page.goto(`${origin}/city`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60_000 });
  await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  await page.waitForFunction(
    () => ['webtransport', 'websocket'].includes(window.__VIBE_E2E__.snapshot().transport),
    null, { timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60_000 });

  const opening = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
  if (opening.transport !== 'webtransport') {
    await browser.close();
    throw new Error(
      `transport=${opening.transport}; the city stream is datagram-only, so the world will be empty`);
  }
  if (!options.quiet) {
    console.log(`connected  transport=${opening.transport}  player=${opening.playerId}`);
  }
  return { browser, page, opening };
}

/** The city panel of the read-only snapshot. */
export const city = (page) => page.evaluate(() => window.__VIBE_E2E__.snapshot().city ?? {});

/** Where the player is and where they are looking. */
export const player = (page) => page.evaluate(() => {
  const s = window.__VIBE_E2E__.snapshot();
  return { position: s.position, camera: s.cameraPosition, yaw: s.cameraYaw, pitch: s.cameraPitch,
    hp: s.hp, onGround: s.onGround, shotsFired: s.shotsFired, lastShot: s.lastShotOutcome };
});

/** Wait until the city reports at least `count` broken bonds. */
export async function waitForBonds(page, count, timeout = 30_000) {
  await page.waitForFunction(
    (want) => (window.__VIBE_E2E__.snapshot().city?.brokenBonds ?? 0) >= want,
    count, { timeout });
}
