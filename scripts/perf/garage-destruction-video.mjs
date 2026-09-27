#!/usr/bin/env node
// Record the /garage destruction range while the range cannon takes a car apart
// one named part at a time ("Fire at part": a clear line to each part).
// Needs the destructible garage server (scripts/perf/garage-vehicle-server.sh)
// and the client (cd client && npx vite, port 3003).
//
//   node scripts/perf/garage-destruction-video.mjs [out.mp4]
//
// GARAGE_URL (default http://localhost:3003), BALL_MASS (3000 kg),
// BALL_SPEED (20 m/s; faster balls pass through thin parts), SHOT_GAP_MS.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(join(root, 'client/package.json'))('playwright');
const out = resolve(process.argv[2] ?? join(root, 'target/garage-destruction.mp4'));
const base = process.env.GARAGE_URL ?? 'http://localhost:3003';
const mass = Number(process.env.BALL_MASS ?? 3000), speed = Number(process.env.BALL_SPEED ?? 20);
const gap = Number(process.env.SHOT_GAP_MS ?? 2200);
// Telemetry beside the video: <out>.telemetry.jsonl, one line per ~50 ms.
const telemetryPath = out.replace(/\.mp4$/, '') + '.telemetry.jsonl';
// METEOR=1: stand back and drop the city's meteor on the car instead of shooting.
const meteorOnly = process.env.METEOR === '1';
const targets = meteorOnly ? [] : ['Front left wheel assembly', 'Headlight housing', 'Nose panel', 'Front right wheel assembly',
  'Headlight housing', 'Rear left wheel assembly', 'Fuel tank', 'Rear right wheel assembly', 'Mirror housing',
  'Left cage member 5', 'Right cage member 5', 'Front roof crossmember', 'Seat back', 'Steering wheel assembly',
  'Rear bumper', 'Exhaust muffler', 'Fire extinguisher'];

const qmul = (a, b) => [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0], a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const qrot = (q, v) => { const t = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [t[0], t[1], t[2]]; };
const qinv = q => [-q[0], -q[1], -q[2], q[3]];
/** Part pose = hull world * rest^-1, as [position, rotation]. */
function partPose(h) {
  const ri = qinv(h.restRotation), q = qmul(h.rotation, ri), r = qrot(q, h.rest);
  return [[h.position[0] - r[0], h.position[1] - r[1], h.position[2] - r[2]], q];
}
/** Bilinear terrain height from the session's world document. */
function terrainSampler(world) {
  const t = world.terrain, n = t.tileGridSize, half = t.tileHalfExtentM, tile = t.tiles?.[0];
  if (!tile || n < 2) return () => 0;
  return (x, z) => {
    const col = Math.min(Math.max((x + half) / (2 * half) * (n - 1), 0), n - 1), row = Math.min(Math.max((z + half) / (2 * half) * (n - 1), 0), n - 1);
    const c = Math.min(Math.floor(col), n - 2), r = Math.min(Math.floor(row), n - 2), u = col - c, v = row - r, h = tile.heights;
    return (h[r*n+c]*(1-u) + h[r*n+c+1]*u)*(1-v) + (h[(r+1)*n+c]*(1-u) + h[(r+1)*n+c+1]*u)*v;
  };
}
function summarise(d, assembly, terrain) {
  const bodies = new Map();
  for (const h of d.hulls) {
    const part = assembly.parts[h.part], shape = part.shapes[h.ordinal], [p, q] = partPose(h);
    const o = [part.position[0]+shape.position[0], part.position[1]+shape.position[1], part.position[2]+shape.position[2]];
    const b = bodies.get(h.actor) ?? { parts: new Set(), minY: Infinity, penetration: -Infinity, excludedPenetration: -Infinity, at: null };
    b.parts.add(h.part);
    for (const v of shape.vertices) {
      const w = qrot(q, [o[0]+v[0], o[1]+v[1], o[2]+v[2]]); w[0] += p[0]; w[1] += p[1]; w[2] += p[2];
      const depth = terrain(w[0], w[2]) - w[1];
      b.minY = Math.min(b.minY, w[1]);
      if (h.terrainExcluded) b.excludedPenetration = Math.max(b.excludedPenetration, depth);
      else if (depth > b.penetration) { b.penetration = depth; b.at = { part: h.part, name: part.name, point: w.map(x => +x.toFixed(3)) }; }
    }
    bodies.set(h.actor, b);
  }
  return { tick: d.serverTick, brokenBonds: d.brokenBonds, rejectedSteps: d.rejectedSteps, lastStatus: d.lastStatus,
    vehicle: d.vehicle, vehicle2: d.vehicle2,
    bodies: d.actors.map(a => { const b = bodies.get(a.actor);
      return { actor: a.actor, parts: b ? b.parts.size : 0, mass: a.mass, com: a.centerOfMass, v: a.linearVelocity, w: a.angularVelocity,
        sleeping: a.sleeping, gravityDisabled: a.gravityDisabled, minY: b?.minY, penetration: b?.penetration, excludedPenetration: b?.excludedPenetration, deepest: b?.at }; }) };
}

const videoDir = mkdtempSync(join(tmpdir(), 'garage-video-'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
await page.addInitScript(() => {
  globalThis.__VIBE_VEHICLE_TRACE__ = [];
  // Per frame: every meteor as drawn (source: arc, streamed body, hold) with
  // the arc position and the raw streamed body for comparison.
  const frame = () => {
    const bridge = globalThis.__VIBE_E2E__, trace = globalThis.__VIBE_VEHICLE_TRACE__;
    try {
      const meteors = bridge?.meteors?.() ?? [];
      const world = bridge?.drawnWorld?.();
      const bodies = (world?.bodies ?? []).filter(b => b.shapeType !== undefined);
      if ((meteors.length || bodies.length) && trace.length < 40000) trace.push({ kind: 'meteor', t: performance.now(), meteors, bodies });
    } catch {}
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
const recordingStarted = Date.now();
let rangeStarted = recordingStarted;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  await page.goto(`${base}/garage`);
  const button = page.getByRole('button', { name: 'Destruction range' });
  await button.waitFor();
  for (let i = 0; i < 120 && !(await button.isEnabled()); i++) await sleep(500);
  const session = page.waitForResponse(r => r.url().endsWith('/vehicle-assets/session') && r.request().method() === 'POST', { timeout: 120_000 });
  await button.click();
  const { matchId, vehicle, worldDocument } = await (await session).json();
  const terrain = terrainSampler(worldDocument);
  const origin = new URL(page.url()).origin.replace(/:\d+$/, ':4001');
  const api = `${origin}/vehicle-assets/session/${encodeURIComponent(matchId)}`;
  const assembly = await (await fetch(`${origin}/vehicle-assets/${vehicle.geometryHash}/metadata.json`)).json();
  await page.getByRole('button', { name: 'Details' }).waitFor({ timeout: 60_000 });
  // Wait for the stage to configure, then walk to ~6 m from the car.
  for (let i = 0; i < 60; i++) { const r = await fetch(`${api}/debug`); if (r.ok && (await r.json()).configured) break; await sleep(500); }
  await page.getByRole('button', { name: 'Details' }).click();
  // Collapse the controls help so the car is in view; show the ball on the toolbar.
  await page.getByText('CONTROLS', { exact: false }).first().click().catch(() => {});
  await page.locator('.garage-debug-bar select').first().selectOption(String(mass)).catch(() => {});
  await page.locator('.garage-debug-bar select').nth(1).selectOption(String(speed)).catch(() => {});
  await page.evaluate(() => (document.activeElement)?.blur?.());
  rangeStarted = Date.now();
  if (!meteorOnly) { await page.keyboard.down('KeyW'); await sleep(1100); await page.keyboard.up('KeyW'); }
  await fetch(`${api}/range`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ballMass: mass, ballSpeed: speed }) });
  const telemetry = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const started = Date.now();
      try { const r = await fetch(`${api}/debug`); if (r.ok) { const d = await r.json(); telemetry.push({ t: started - rangeStarted, serverBodies: d.bodies, ...summarise(d, assembly, terrain) }); } } catch {}
      await sleep(Math.max(0, 50 - (Date.now() - started)));
    }
  })();
  await sleep(1500);
  const used = new Set();
  for (const name of targets) {
    const debug = await (await fetch(`${api}/debug`)).json();
    const onCar = new Set(debug.hulls.filter(h => h.actor === 0).map(h => h.part));
    const part = assembly.parts.findIndex((p, i) => p.name === name && !used.has(i) && onCar.has(i));
    if (part < 0) { console.log(`skip ${name}: not on the car`); continue; }
    used.add(part);
    telemetry.push({ t: Date.now() - rangeStarted, shot: { part, name } });
    await fetch(`${api}/range/fire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part }) });
    await sleep(gap);
    const after = await (await fetch(`${api}/debug`)).json();
    const off = new Set(after.hulls.filter(h => h.actor !== 0).map(h => h.part)).size;
    console.log(`fired at ${name} #${part}: ${after.brokenBonds} bonds broken, ${off} parts off the car, ${after.actors.length} bodies`);
  }
  if (meteorOnly) {
    telemetry.push({ t: Date.now() - rangeStarted, shot: { part: -1, name: 'meteor' } });
    await fetch(`${api}/range/meteor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await sleep(12000);
    const after = await (await fetch(`${api}/debug`)).json();
    const off = new Set(after.hulls.filter(h => h.actor !== 0).map(h => h.part)).size;
    console.log(`meteor: ${after.brokenBonds} of ${after.bonds.length} bonds broken, ${off} parts off the car, ${after.actors.length} bodies`);
  }
  await sleep(4000);
  sampling = false; await sampler;
  // The client's own view: rig packets received and car frames drawn.
  const clientTrace = await page.evaluate(() => globalThis.__VIBE_VEHICLE_TRACE__ ?? []);
  const offset = await page.evaluate(() => performance.timeOrigin);
  for (const row of clientTrace) telemetry.push({ client: row, t: Math.round(offset + row.t - rangeStarted) });
  telemetry.sort((a, b) => a.t - b.t);
  writeFileSync(telemetryPath, telemetry.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`telemetry: ${telemetryPath} (${telemetry.length} samples)`);
} finally {
  await context.close();
  await browser.close();
}
const [webm] = readdirSync(videoDir).filter(f => f.endsWith('.webm'));
const skip = Math.max(0, (rangeStarted - recordingStarted) / 1000 - 0.5).toFixed(2);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip, '-i', join(videoDir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
rmSync(videoDir, { recursive: true, force: true });
console.log(`video: ${out}`);
