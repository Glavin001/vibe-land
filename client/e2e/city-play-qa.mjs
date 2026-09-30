// City play QA: can a player walk, and does a meteor damage a building?
//
// Joins /city in headless Chromium the way scripts/vast-city-verify.mjs does
// (software GL, the advertised WebTransport host rewritten to loopback to
// avoid NAT hairpin), then:
//
//   walk    hold W for 3 s; the server-authoritative position must move
//   meteor        drop a meteor (server endpoint) on the building nearest the
//                 player; the stage must break bonds within 8 s
//   clientMeteor  the player's own shot: meteor mode, aim at another building,
//                 pull the trigger; bonds must break within 12 s
//   carMeteor     a meteor on destructible car 1001 must knock parts off
//                 (skipped when the city fields stock cars)
//
// Prints one JSON report and exits 0 only when every check passes.
//
//   cd client && node e2e/city-play-qa.mjs https://127.0.0.1:1111 http://127.0.0.1:4017 4433 [out.json]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const [origin, api, udpPort, output] = process.argv.slice(2);
if (!origin || !api || !/^\d+$/.test(udpPort ?? '')) {
  console.error('usage: city-play-qa.mjs <web https origin> <api http origin> <local udp port> [out.json]');
  process.exit(2);
}
const MATCH = 'city-default';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { ok: false, walk: null, meteor: null, errors: [] };
const deadline = setTimeout(() => { report.errors.push('exceeded 150 s'); finish(1); }, 150_000);
let browser;
function finish(code) {
  clearTimeout(deadline);
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  browser?.close().catch(() => {});
  process.exit(code);
}
const stats = async () => {
  const r = await fetch(`${api}/match-stats/${MATCH}`);
  if (!r.ok) return null;
  const d = await r.json();
  const v = (k) => d.spans?.[k]?.v ?? null;
  return { tick: d.server_tick, players: d.player_count, errorFrames: v('destruction/native_error_frames'),
    errorBits: v('destruction/native_error_bits_last'), awake: d.physics_active_dynamic_bodies,
    brokenBonds: d.city?.broken_bonds ?? null, tickMs: d.timings?.total_ms?.avg };
};

try {
  browser = await chromium.launch({ headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 640, height: 360 } });
  page.on('pageerror', (e) => report.errors.push(String(e).slice(0, 300)));
  await page.addInitScript(() => {
    for (const [k, v] of Object.entries({ tier: 'fast', shadows: '0', ao: '0', cityTextures: 'off', skyIbl: '0', skyDome: '0', dprCap: '1' }))
      localStorage.setItem(`vibe.render.${k}`, v);
  });
  await page.route('**/session-config*', async (route) => {
    const response = await route.fetch(); const body = await response.json(); const url = new URL(body.url);
    url.hostname = '127.0.0.1'; url.port = udpPort; body.url = url.toString();
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${origin}/city?portal=true&match=${MATCH}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 20_000 });
  await page.mouse.click(320, 180);
  await page.waitForFunction(() => {
    const s = window.__VIBE_E2E__.snapshot();
    return s.connected && s.playerId > 0 && s.city?.rendered && s.city.chunksTotal > 0;
  }, null, { timeout: 60_000 });
  const snap = () => page.evaluate(() => window.__VIBE_E2E__.snapshot());
  await sleep(2000); // let the spawn settle onto the ground

  // ---- walk ----
  const before = await snap();
  await page.mouse.click(320, 180);
  await page.keyboard.down('w');
  await sleep(3000);
  await page.keyboard.up('w');
  await sleep(500);
  const after = await snap();
  const moved = Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2]);
  report.walk = { from: before.position.map((n) => +n.toFixed(2)), to: after.position.map((n) => +n.toFixed(2)),
    horizontalMetres: +moved.toFixed(2), pass: moved > 2 };

  // ---- meteor ----
  const buildings = await (await fetch(`${api}/city-buildings`)).json();
  const list = Array.isArray(buildings) ? buildings : buildings.buildings ?? [];
  const centre = (b) => b.center ?? b.centre ?? b.position ?? (b.min && b.max ? b.min.map((m, i) => (m + b.max[i]) / 2) : null);
  const p = after.position;
  const target = list.map(centre).filter(Boolean)
    .sort((a, b) => Math.hypot(a[0] - p[0], a[2] - p[2]) - Math.hypot(b[0] - p[0], b[2] - p[2]))[0];
  if (!target) throw Error(`no building positions in /city-buildings (${JSON.stringify(list[0] ?? buildings).slice(0, 200)})`);
  const s0 = await stats(); const c0 = (await snap()).city;
  const r = await fetch(`${api}/city-meteor/${MATCH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ x: target[0], y: target[1], z: target[2] }) });
  let s1 = s0, c1 = c0;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    s1 = await stats(); c1 = (await snap()).city;
    if ((c1.brokenBonds ?? 0) > (c0.brokenBonds ?? 0) + 5) break;
  }
  const broke = (c1.brokenBonds ?? 0) - (c0.brokenBonds ?? 0);
  report.meteor = { target: target.map((n) => +n.toFixed(1)), request: `${r.status} ${await r.text()}`,
    clientBrokenBonds: [c0.brokenBonds, c1.brokenBonds], clientChunksAwake: [c0.chunksAwake, c1.chunksAwake],
    server: { before: s0, after: s1 }, pass: broke > 5 };

  // ---- the player's own meteor: shot mode, aim at another building, trigger ----
  const others = list.map(centre).filter(Boolean)
    .sort((a, b) => Math.hypot(a[0] - p[0], a[2] - p[2]) - Math.hypot(b[0] - p[0], b[2] - p[2]));
  const aim = others.find((b) => Math.hypot(b[0] - target[0], b[2] - target[2]) > 20) ?? others[1];
  const c2 = (await snap()).city;
  await page.evaluate(() => window.__VIBE_E2E__.setShotMode('meteor'));
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), aim);
  await sleep(400);
  await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 80 }));
  let c3 = c2, launched = 0;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    c3 = (await snap()).city;
    launched = Math.max(launched, (await page.evaluate(() => window.__VIBE_E2E__.meteors?.().length ?? 0)));
    if ((c3.brokenBonds ?? 0) > (c2.brokenBonds ?? 0) + 5) break;
  }
  report.clientMeteor = { aim: aim.map((n) => +n.toFixed(1)), meteorsSeen: launched,
    clientBrokenBonds: [c2.brokenBonds, c3.brokenBonds], pass: (c3.brokenBonds ?? 0) - (c2.brokenBonds ?? 0) > 5 };

  // ---- a meteor on a destructible car (when the city fields them) ----
  // `car` is the fleet index (id = 1001 + index) on this server; accept an id too.
  let carQuery = 'car=0';
  let car = await fetch(`${api}/city-vehicle-debug/${MATCH}?${carQuery}`);
  if (!car.ok) { carQuery = 'car=1001'; car = await fetch(`${api}/city-vehicle-debug/${MATCH}?${carQuery}`); }
  if (car.ok) {
    const off = (d) => new Set((d.hulls ?? []).filter((h) => h.actor !== 0).map((h) => h.part)).size;
    const d0 = await car.json();
    const at = d0.snapshot?.position ?? d0.vehicle2?.position;
    await fetch(`${api}/city-meteor/${MATCH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: at[0], y: at[1], z: at[2] }) });
    let partsOff = off(d0);
    for (let i = 0; i < 20 && partsOff <= off(d0); i++) {
      await sleep(500);
      partsOff = off(await (await fetch(`${api}/city-vehicle-debug/${MATCH}?${carQuery}`)).json());
    }
    report.carMeteor = { car: carQuery, at: at.map((n) => +n.toFixed(1)), partsOff: [off(d0), partsOff], pass: partsOff > off(d0) };
  } else {
    report.carMeteor = { skipped: `no destructible fleet car (${car.status})`, pass: true };
  }
  report.final = await stats();

  report.ok = report.walk.pass && report.meteor.pass && report.clientMeteor.pass && report.carMeteor.pass
    && report.errors.length === 0;
  finish(report.ok ? 0 : 1);
} catch (e) {
  report.errors.push(String(e).slice(0, 500));
  finish(1);
}
