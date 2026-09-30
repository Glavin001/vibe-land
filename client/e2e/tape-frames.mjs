// Render a recorded tape frame by frame, as the player's camera saw it.
//
// Opens /cityreplay on the dev client with a tape (served from client/public),
// pauses, and for each frame seeks one step and screenshots, so consecutive
// images are consecutive frames -- what a video at 25 fps smears together.
//
//   cd client && node e2e/tape-frames.mjs <tape under public/> <fromMs> <toMs> [stepMs=16.7] [outDir]
//   e.g. node e2e/tape-frames.mjs zz-session-tape-assets.vltape 15000 16500
// (scripts/tape-add-vehicle-assets.ts makes a tape whose garage cars draw.)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [tape, fromArg, toArg, stepArg, outArg] = process.argv.slice(2);
if (!tape || !fromArg || !toArg) { console.error('usage: tape-frames.mjs <tape> <fromMs> <toMs> [stepMs] [outDir]'); process.exit(2); }
const from = Number(fromArg), to = Number(toArg), step = Number(stepArg ?? 1000 / 60);
const out = resolve(outArg ?? `../target/tape-frames/${tape.replace(/\W+/g, '-')}-${from}`);
mkdirSync(out, { recursive: true });
const CLIENT = process.env.QA_CLIENT ?? 'http://localhost:3003';
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${CLIENT}/cityreplay?src=/${tape}&grass=0`);
for (let i = 0; i < 120 && !(await page.evaluate(() => window.__VIBE_REPLAY__?.ready?.() ?? false)); i++) await page.waitForTimeout(500);
await page.evaluate(() => window.__VIBE_REPLAY__.pause());
// Play into the window once so the world state is the one the tape built.
await page.evaluate(async (ms) => { await window.__VIBE_REPLAY__.seek(ms); }, Math.max(0, from - 2000));
await page.evaluate(() => { window.__VIBE_REPLAY__.setSpeed(1); window.__VIBE_REPLAY__.play(); });
await page.waitForTimeout(Math.min(2000, from));
await page.evaluate(() => window.__VIBE_REPLAY__.pause());
let n = 0;
for (let t = from; t <= to; t += step) {
  await page.evaluate(async (ms) => { await window.__VIBE_REPLAY__.seek(ms); }, t);
  // Two animation frames: one to apply the seek, one to draw it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: `${out}/f${String(n++).padStart(4, '0')}.png` });
}
await browser.close();
console.log(`${n} frames -> ${out}`);
