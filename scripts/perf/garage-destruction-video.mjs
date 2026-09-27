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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(join(root, 'client/package.json'))('playwright');
const out = resolve(process.argv[2] ?? join(root, 'target/garage-destruction.mp4'));
const base = process.env.GARAGE_URL ?? 'http://localhost:3003';
const mass = Number(process.env.BALL_MASS ?? 3000), speed = Number(process.env.BALL_SPEED ?? 20);
const gap = Number(process.env.SHOT_GAP_MS ?? 2200);
const targets = ['Front left wheel assembly', 'Headlight housing', 'Nose panel', 'Front right wheel assembly',
  'Headlight housing', 'Rear left wheel assembly', 'Fuel tank', 'Rear right wheel assembly', 'Mirror housing',
  'Left cage member 5', 'Right cage member 5', 'Front roof crossmember', 'Seat back', 'Steering wheel assembly',
  'Rear bumper', 'Exhaust muffler', 'Fire extinguisher'];

const videoDir = mkdtempSync(join(tmpdir(), 'garage-video-'));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
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
  const { matchId, vehicle } = await (await session).json();
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
  await page.keyboard.down('KeyW'); await sleep(1100); await page.keyboard.up('KeyW');
  await fetch(`${api}/range`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ballMass: mass, ballSpeed: speed }) });
  await sleep(1500);
  const used = new Set();
  for (const name of targets) {
    const debug = await (await fetch(`${api}/debug`)).json();
    const onCar = new Set(debug.hulls.filter(h => h.actor === 0).map(h => h.part));
    const part = assembly.parts.findIndex((p, i) => p.name === name && !used.has(i) && onCar.has(i));
    if (part < 0) { console.log(`skip ${name}: not on the car`); continue; }
    used.add(part);
    await fetch(`${api}/range/fire`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part }) });
    await sleep(gap);
    const after = await (await fetch(`${api}/debug`)).json();
    const off = new Set(after.hulls.filter(h => h.actor !== 0).map(h => h.part)).size;
    console.log(`fired at ${name} #${part}: ${after.brokenBonds} bonds broken, ${off} parts off the car, ${after.actors.length} bodies`);
  }
  await sleep(4000);
} finally {
  await context.close();
  await browser.close();
}
const [webm] = readdirSync(videoDir).filter(f => f.endsWith('.webm'));
const skip = Math.max(0, (rangeStarted - recordingStarted) / 1000 - 0.5).toFixed(2);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip, '-i', join(videoDir, webm), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out]);
rmSync(videoDir, { recursive: true, force: true });
console.log(`video: ${out}`);
