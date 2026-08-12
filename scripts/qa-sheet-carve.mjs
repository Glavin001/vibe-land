#!/usr/bin/env node
/**
 * Browser QA for destructible sheet huts.
 * Requires client at http://localhost:5555 and (for practice) no server dependency.
 *
 * Usage: node scripts/qa-sheet-carve.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../client/package.json'));
const { chromium } = require('@playwright/test');

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:5555';
const OUT = process.env.QA_OUT_DIR ?? '/opt/cursor/artifacts/qa-sheet-carve';
mkdirSync(OUT, { recursive: true });

const DRYWALL_WALL = { x: 4.0, y: 1.4, z: -13.6 };
const WOOD_WALL = { x: 14.0, y: 1.4, z: -13.6 };

async function waitForQa(page, timeoutMs = 30000) {
  await page.waitForFunction(() => !!window.__VIBE_SHEET_QA__, null, { timeout: timeoutMs });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  console.log('Opening', `${BASE}/practice`);
  await page.goto(`${BASE}/practice`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.screenshot({ path: join(OUT, '01-landing.png') });

  // Click to join
  await page.mouse.click(640, 360);
  await page.waitForTimeout(1500);
  // Second click helps if first only dismissed overlay
  await page.mouse.click(640, 360);
  await waitForQa(page);
  await page.waitForFunction(
    () => window.__VIBE_E2E__?.snapshot()?.connected === true,
    null,
    { timeout: 30000 },
  );
  await page.screenshot({ path: join(OUT, '02-joined.png') });

  const before = await page.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  console.log('carve count before:', before);

  // Fire a burst at drywall then wood hut walls.
  for (let i = 0; i < 8; i += 1) {
    const result = await page.evaluate(
      (wall) => window.__VIBE_SHEET_QA__.fireAt(wall.x, wall.y, wall.z),
      DRYWALL_WALL,
    );
    console.log('drywall fire', i, result);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const afterDrywall = await page.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  console.log('carve count after drywall:', afterDrywall);
  await page.screenshot({ path: join(OUT, '03-after-drywall-shots.png') });

  for (let i = 0; i < 6; i += 1) {
    const result = await page.evaluate(
      (wall) => window.__VIBE_SHEET_QA__.fireAt(wall.x, wall.y, wall.z),
      WOOD_WALL,
    );
    console.log('wood fire', i, result);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const afterWood = await page.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  const events = await page.evaluate(() => window.__VIBE_SHEET_QA__.getCarveEvents());
  console.log('carve count after wood:', afterWood);
  console.log('events sample:', events.slice(0, 3));
  await page.screenshot({ path: join(OUT, '04-after-wood-shots.png') });

  // Fire a dense cluster so the hole is unmistakable, then screenshot from close range
  // by temporarily overriding the camera look via canvas + walking isn't reliable in
  // headless — instead evaluate mesh index counts if exposed, and capture page shots.
  for (let i = 0; i < 12; i += 1) {
    // Spread a few cm so adjacent stamps merge into a larger opening.
    const wall = {
      x: DRYWALL_WALL.x + (i % 3) * 0.04,
      y: DRYWALL_WALL.y + Math.floor(i / 3) * 0.04,
      z: DRYWALL_WALL.z,
    };
    await page.evaluate((w) => window.__VIBE_SHEET_QA__.fireAt(w.x, w.y, w.z), wall);
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(800);
  const finalCount = await page.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  console.log('final carve count:', finalCount);

  // Point the in-game camera at the drywall wall by dispatching a look via the
  // canvas center clicks is insufficient; grab a wide screenshot of the scene.
  await page.screenshot({ path: join(OUT, '05-after-cluster-carves.png'), fullPage: false });

  const meshStats = await page.evaluate(() => {
    const qa = window.__VIBE_SHEET_QA__;
    if (!qa?.getSheetMeshStats) return { error: 'no-mesh-stats-hook' };
    const sheets = qa.getSheetMeshStats();
    return { sheetCount: sheets.length, sheets };
  });
  console.log('mesh stats:', JSON.stringify(meshStats, null, 2));

  const snap = await page.evaluate(() => window.__VIBE_E2E__?.snapshot?.() ?? null);
  console.log('e2e snapshot position:', snap?.position, 'shotsFired:', snap?.shotsFired);

  await browser.close();

  const sheets = meshStats.sheets ?? [];
  const carvedSheets = sheets.filter((s) => (s.carvedCells ?? 0) > 0);
  const hasCarvedCells = carvedSheets.some((s) => s.carvedCells >= 8);

  const pass =
    afterWood > before &&
    afterDrywall > before &&
    finalCount >= 3 &&
    (meshStats.sheetCount ?? 0) >= 12 &&
    hasCarvedCells;
  const report = {
    pass,
    before,
    afterDrywall,
    afterWood,
    finalCount,
    eventCount: events.length,
    meshStats,
    hasVariance,
    consoleErrors: consoleErrors.slice(0, 20),
    position: snap?.position ?? null,
    shotsFired: snap?.shotsFired ?? null,
    artifacts: OUT,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
