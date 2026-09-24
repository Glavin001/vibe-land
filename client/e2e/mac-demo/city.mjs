import { open, banner, caption, liveStats, snap, sleep } from './session.mjs';
import { dumpFps } from './session.mjs';
import { mark, walkTo, driveTo, enterNearest } from './nav.mjs';
const OUT = process.argv[2];
const PART = process.argv[3] || 'all';
const { browser, context, page, renderer } = await open({ path: '/city', record: OUT });
mark(`joined; renderer ${renderer}`);
await page.waitForFunction(() => (window.__VIBE_E2E__.snapshot().city?.chunksTotal ?? 0) > 0, null, { timeout: 120000 });
await sleep(4000);
const cityStats = async () => (await snap(page)).city;
mark(`city ${JSON.stringify(await cityStats()).slice(0, 200)}`);
await banner(page, 'vibe-land /city on a Mac: PhysX GPU rigid bodies + native destruction on Apple Silicon (Metal, via CuMetal)');
const span = (s, k) => s.spans?.[k]?.v ?? 0;
const stop = liveStats(page, 'city-default', (s) => `  fractures ${span(s, 'destruction/native_splits')}  chunks ${span(s, 'destruction/native_chunks')}`);

const s0 = await snap(page);
const r0 = Math.hypot(s0.position[0], s0.position[2]);
const sideOf = (d, lat) => [s0.position[0] * (1 - d / r0) - (s0.position[2] / r0) * lat, s0.position[2] * (1 - d / r0) + (s0.position[0] / r0) * lat];
if (PART !== 'car') {
  // Cannonballs into the nearest building face.
  await page.evaluate(() => window.__VIBE_E2E__.setCannonball(true));
  let s = s0;
  const r = r0;
  // Spawns face down a street; step sideways onto the building on the right.
  const side = Number(process.env.SIDE ?? 14);
  const inward = (d, lat = side) => [s.position[0] * (1 - d / r) - (s.position[2] / r) * lat, s.position[2] * (1 - d / r) + (s.position[0] / r) * lat];
  const [ax, az] = inward(22);
  await caption(page, 'Cannonballs (dynamic spheres) hit a bonded building: GPU contacts drive the stress solver, chunks break off as convex hulls');
  for (const h of [3, 6, 9, 5]) {
    await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [ax, h, az]);
    await sleep(500);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.__VIBE_DRIVE__.fire({ holdMs: 250 }));
      await sleep(1600);
    }
  }
  mark(`after cannon: ${JSON.stringify(await cityStats()).slice(0, 160)}`);
  await sleep(3000);
  // Walk back out for a wider view, then drop a tower.
  const [bx, bz] = inward(-12, 0);
  await walkTo(page, bx, bz, { within: 2, timeoutMs: 8000 });
  const [dx, dz] = inward(24, -side);
  await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [dx, 10, dz]);
  await sleep(800);
  await caption(page, 'Demolition: a building footing is cut and the structure collapses under gravity; every fragment is a GPU rigid body');
  const res = await fetch('http://127.0.0.1:4001/city-demolish/city-default', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: dx, z: dz, radius_m: 10, below_y: 8, rounds: 48 }),
  });
  mark(`demolish at (${dx.toFixed(1)}, ${dz.toFixed(1)}): ${await res.text()}`);
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    await page.evaluate(([x, y, z]) => window.__VIBE_DRIVE__.lookAt(x, y, z), [dx, Math.max(3, 10 - i * 1.5), dz]);
  }
  mark(`after demolish: ${JSON.stringify(await cityStats()).slice(0, 160)}`);
}

if (PART !== 'destroy') {
  let s = await snap(page);
  const me = s.position;
  const nearest = () => s.vehicles.reduce((a, b) => (Math.hypot(a.position[0] - me[0], a.position[2] - me[2]) < Math.hypot(b.position[0] - me[0], b.position[2] - me[2]) ? a : b));
  if (!s.vehicles.length) {
    // Cars sit on the spawn ring at (+-ring, +-8); walk round the ring to the nearer one.
    const ang = Math.atan2(me[2], me[0]);
    const target = Math.abs(Math.cos(ang)) > 0 && me[0] > 0 ? [63, 8] : [-63, -8];
    await caption(page, 'Walking round the city to a car');
    const steps = 6;
    const a1 = Math.atan2(target[1], target[0]);
    let da = a1 - ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 1; k <= steps; k++) {
      const a = ang + da * k / steps;
      await walkTo(page, 70 * Math.cos(a), 70 * Math.sin(a), { within: 4, timeoutMs: 15000 });
    }
    s = await snap(page);
  }
  const v = nearest();
  mark(`car ${JSON.stringify(v)}`);
  await walkTo(page, v.position[0] + 2, v.position[2] + 2, { within: 2, timeoutMs: 15000 });
  const inCar = await enterNearest(page, v.id);
  mark(`in car ${inCar}`);
  await caption(page, 'Driving through the streets: Vehicle2 constraint rows + chassis contacts against buildings and debris, solved on the GPU');
  const a0 = Math.atan2(s0.position[2], s0.position[0]);
  const ring = (da, rad = 76) => [rad * Math.cos(a0 + da), rad * Math.sin(a0 + da)];
  const rubble = sideOf(22, 14);
  const route = [sideOf(8, 12), rubble, sideOf(-10, 8), ring(0.5), ring(1.0), ring(1.5), ring(2.0)];
  mark(`route ${JSON.stringify(route.map((p) => p.map((v) => +v.toFixed(0))))}`);
  const top = await driveTo(page, v.id, route, { log: mark, legMs: 14000, within: 5 });
  mark(`max speed ${top.toFixed(1)}`);
}
await sleep(2000);
const fin = await (await fetch('http://127.0.0.1:4001/match-stats/city-default')).json();
mark(`final gpu_active=${fin.physics_gpu_active} warnings=${fin.physics_gpu_warning_count} splits=${span(fin, 'destruction/native_splits')}`);
stop();
await dumpFps(page);
const video = page.video();
await context.close(); await browser.close();
if (video) console.log('video', await video.path());
