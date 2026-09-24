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
 * @param {string} [options.recordVideo]  directory for a webm recording of the run
 * @param {boolean} [options.public]  dial the advertised public address instead of loopback
 * @param {string} [options.query]    query string for /city, without the '?'
 */
export async function openCity(options = {}) {
  const origin = options.page ?? 'https://127.0.0.1:1111';
  const wtPort = String(options.wtPort ?? 4433);
  const viewport = options.viewport ?? { width: 1280, height: 800 };

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  // --use-angle=vulkan is what puts WebGL on the real card. Without it every
  // other spelling here -- the default, --use-gl=egl, --use-gl=angle,
  // --use-angle=gl-egl -- silently lands on SwiftShader or llvmpipe, and the
  // city renders in software at about one frame a second. That is not merely
  // slow: the drive's trigger is a deadline read once per rendered frame, so
  // at that rate shots are set and expire without a frame ever seeing them,
  // and a whole QA run reports firing while nothing leaves the muzzle.
  //
  // Verified on this host: ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX
  // 4090), NVIDIA). Headless, no Xvfb, no sandbox flags needed. Where there is
  // no Vulkan device the flag is ignored and Chromium falls back on its own.
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors', '--use-angle=vulkan'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport,
    ...(options.recordVideo ? { recordVideo: { dir: options.recordVideo, size: viewport } } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  // Rewrite only host:port of the advertised WebTransport URL, keeping its
  // path. Replacing the whole URL would repair a malformed one, and the run
  // would then pass against a server no real client can reach.
  //
  // Skipped entirely in public mode. The rewrite is what makes a loopback run
  // possible, and it is also what makes a loopback run unrepresentative: it
  // bypasses the host's port mapping and the public address a player actually
  // dials, so a break anywhere in that path is invisible here.
  if (!options.public) await page.route('**/session-config*', async (route) => {
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
  const query = options.query ? `?${options.query}` : '';
  await page.goto(`${origin}/city${query}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 60_000 });
  await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  // WebTransport, or the client's "WebSocket transport is disabled" failure
  // (there is no WebSocket fallback), whichever comes first.
  await page.waitForFunction(
    () => window.__VIBE_E2E__.snapshot().transport === 'webtransport'
      || document.body.innerText.includes('WebSocket transport is disabled'),
    null, { timeout: 60_000 });
  await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60_000 });

  const opening = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
  if (opening.transport !== 'webtransport') {
    await browser.close();
    throw new Error(
      `transport=${opening.transport}: WebTransport did not connect and WebSocket is disabled`);
  }
  // Say which renderer got picked, every time. A run that quietly dropped to
  // software still produces plausible output, and the numbers in it are wrong.
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  const software = /SwiftShader|llvmpipe|softpipe/i.test(renderer);
  if (!options.quiet) {
    console.log(`connected  transport=${opening.transport}  player=${opening.playerId}`);
    console.log(`renderer   ${software ? 'SOFTWARE -- timings and frame-rate claims are meaningless' : renderer.slice(0, 80)}`);
  }
  return { browser, context, page, opening, renderer, software };
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
