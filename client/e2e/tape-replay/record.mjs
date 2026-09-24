// Record a full-world city tape from a real session and sample what the live
// client drew while it ran, for replay.mjs to compare against the replay.
//
//   CLIENT=http://localhost:3103 API=http://127.0.0.1:4101 \
//     node e2e/tape-replay/record.mjs <outDir> [seconds]
//
// The session: cannonballs into a building, a meteor, a demolition, then a
// walk to a car and a drive. Writes into <outDir>: live-samples.json (the
// live renderers' positions on the tape clock, 10 Hz), live-*.png (with their
// tape times in live-shots.json), header.json, the uploaded tape copied from
// the server as tape.vltape, and the city manifest the replay needs offline.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { walkTo, driveTo, enterNearest } from '../mac-demo/nav.mjs';

const CLIENT = process.env.CLIENT ?? 'http://localhost:3103';
const API = process.env.API ?? 'http://127.0.0.1:4101';
const SERVER_CWD = process.env.SERVER_CWD ?? process.cwd();
const OUT = process.argv[2];
const SECONDS = Number(process.argv[3] ?? 95);
if (!OUT) throw new Error('usage: record.mjs <outDir> [seconds]');
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
await page.waitForFunction(() => window.__VIBE_E2E__.snapshot().transport === 'webtransport', null, { timeout: 120000 });
await page.waitForFunction(() => !!window.__VIBE_DRIVE__, null, { timeout: 60000 });
await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 180000 });
mark('joined, city loaded');
await sleep(3000);
const snap = () => page.evaluate(() => window.__VIBE_E2E__.snapshot());

const recording = page.evaluate((s) => window.__VIBE_E2E__.recordTape(s, { upload: true }), SECONDS);
await sleep(300);
const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const sample = await page.evaluate(() => ({
      tapeMs: window.__VIBE_E2E__.tapeElapsedMs(),
      world: window.__VIBE_E2E__.drawnWorld(),
      inVehicle: window.__VIBE_E2E__.snapshot().inVehicle,
    })).catch(() => null);
    if (sample && sample.tapeMs !== null && sample.world) samples.push(sample);
    await sleep(100);
  }
})();
const shots = [];
const shot = async (name) => {
  const tapeMs = await page.evaluate(() => window.__VIBE_E2E__.tapeElapsedMs());
  const file = `live-${name}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  shots.push({ name, file, tapeMs });
  mark(`shot ${name} at tape ${(tapeMs / 1000).toFixed(2)} s`);
};

const s0 = await snap();
const r0 = Math.hypot(s0.position[0], s0.position[2]);
const side = 14;
const inward = (d, lat = side) => [
  s0.position[0] * (1 - d / r0) - (s0.position[2] / r0) * lat,
  s0.position[2] * (1 - d / r0) + (s0.position[0] / r0) * lat,
];
mark(`spawn ${s0.position.map((v) => v.toFixed(1))}`);

// 1. Cannonballs into the building on the right.
await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
const [ax, az] = inward(22);
for (const [i, h] of [3, 6, 9, 5].entries()) {
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [ax, h, az]);
  await sleep(400);
  await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 250 }));
  await sleep(350);
  if (i === 0 || i === 2) await shot(`cannonball-${i}`);
  await sleep(1200);
}
await sleep(1500);

// 2. A meteor onto the block ahead, watched from here.
const [mx, mz] = inward(40, 0);
await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [mx, 12, mz]);
const meteor = await fetch(`${API}/city-meteor/city-default`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: mx, y: 0, z: mz }),
});
mark(`meteor at (${mx.toFixed(1)}, ${mz.toFixed(1)}): ${meteor.status} ${await meteor.text()}`);
for (let i = 0; i < 6; i += 1) {
  await sleep(700);
  const flights = await page.evaluate(() => window.__VIBE_E2E__.drawnWorld()?.meteors ?? []);
  if (flights.some((m) => m.source === 'body' || m.source === 'arc')) {
    await shot(`meteor-${i}`);
    if (flights.some((m) => m.source === 'body')) break;
  }
}
await sleep(3000);

// 3. Demolition of the building on the left.
const [dx, dz] = inward(24, -side);
await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [dx, 10, dz]);
const demolish = await fetch(`${API}/city-demolish/city-default`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ x: dx, z: dz, radius_m: 10, below_y: 8, rounds: 48 }),
});
mark(`demolish: ${demolish.status} ${(await demolish.text()).slice(0, 120)}`);
await sleep(2500);
await shot('demolition');
await sleep(3000);

// 4. A car: walk to the nearest one, drive.
let s = await snap();
const me = s.position;
const dist = (v) => Math.hypot(v.position[0] - me[0], v.position[2] - me[2]);
if (s.vehicles.length) {
  const v = s.vehicles.reduce((a, b) => (dist(a) < dist(b) ? a : b));
  mark(`car ${v.id} at ${v.position.map((x) => x.toFixed(1))}, ${dist(v).toFixed(1)} m`);
  await walkTo(page, v.position[0] + 2, v.position[2] + 2, { within: 2, timeoutMs: 20000 });
  const inCar = await enterNearest(page, v.id);
  mark(`in car ${inCar}`);
  if (inCar) {
    const a0 = Math.atan2(v.position[2], v.position[0]);
    const ring = (da, rad = 76) => [rad * Math.cos(a0 + da), rad * Math.sin(a0 + da)];
    const drivePromise = driveTo(page, v.id, [ring(0.35), ring(0.7), ring(1.05)], { log: mark, legMs: 7000, within: 6 });
    await sleep(4000);
    await shot('driving');
    await drivePromise;
  }
} else {
  mark('no vehicle in the snapshot');
}

const header = await recording;
sampling = false;
await sampler;
mark(`tape: ${JSON.stringify(header).slice(0, 400)}`);
fs.writeFileSync(path.join(OUT, 'header.json'), JSON.stringify(header, null, 2));
fs.writeFileSync(path.join(OUT, 'live-samples.json'), JSON.stringify(samples));
fs.writeFileSync(path.join(OUT, 'live-shots.json'), JSON.stringify(shots, null, 2));
const manifest = await fetch(`${API}/city-manifest/${header.manifestHash}`);
fs.writeFileSync(path.join(OUT, `manifest-${header.manifestHash}.bin`), Buffer.from(await manifest.arrayBuffer()));
if (header.uploadFolder) {
  const from = path.join(SERVER_CWD, 'debug-reports', header.uploadFolder, 'city.vltape');
  fs.copyFileSync(from, path.join(OUT, 'tape.vltape'));
  mark(`uploaded tape ${from} copied`);
} else {
  mark('upload failed');
}
await context.close();
await browser.close();
