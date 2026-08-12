#!/usr/bin/env node
/**
 * Two-client multiplayer sheet-destruction sync demo.
 *
 * Requires server :4001 + client :5555 already running.
 * Usage: node scripts/qa-mp-sheet-sync.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  pathJoin(dirname(fileURLToPath(import.meta.url)), '../client/package.json'),
);
const { chromium } = require('@playwright/test');

const BASE = process.env.QA_BASE_URL ?? 'http://localhost:5555';
const OUT = process.env.QA_OUT_DIR ?? '/opt/cursor/artifacts/qa-mp-sheet-sync';
const HEADLESS = process.env.QA_HEADLESS === '1';
mkdirSync(OUT, { recursive: true });

const DRYWALL_WALL = { x: 4.0, y: 1.4, z: -13.6 };

function dismissCalibrationInit() {
  return () => {
    try {
      const key = 'vibe-land/input-settings';
      const raw = localStorage.getItem(key);
      const settings = raw ? JSON.parse(raw) : {};
      if (!settings.meta || typeof settings.meta !== 'object') settings.meta = {};
      settings.meta.firstRunPromptDismissed = true;
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  };
}

async function openPlay(page, matchId) {
  await page.addInitScript(dismissCalibrationInit());
  await page.goto(`${BASE}/play?match=${encodeURIComponent(matchId)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => !!window.__VIBE_E2E__, null, { timeout: 30_000 });
}

async function joinMatch(page) {
  const overlay = page.locator('[data-testid="join-overlay"]');
  if (await overlay.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await overlay.click();
  } else {
    await page.mouse.click(640, 360);
  }
  await page.waitForFunction(
    () => {
      const s = window.__VIBE_E2E__?.snapshot?.();
      return !!s && s.playerId > 0 && s.transport !== 'connecting';
    },
    null,
    { timeout: 45_000 },
  );
  return page.evaluate(() => window.__VIBE_E2E__.snapshot());
}

async function waitForRemote(page, min = 1) {
  await page.waitForFunction(
    (n) => (window.__VIBE_E2E__?.snapshot?.()?.remotePlayers?.length ?? 0) >= n,
    min,
    { timeout: 45_000 },
  );
}

async function waitForSheetQa(page) {
  await page.waitForFunction(() => !!window.__VIBE_SHEET_QA__, null, { timeout: 30_000 });
}

function distToWall(p) {
  if (!p) return Number.POSITIVE_INFINITY;
  return Math.hypot(p[0] - DRYWALL_WALL.x, p[2] - DRYWALL_WALL.z);
}

async function patchPointerLock(page) {
  await page.locator('canvas').first().click();
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    Object.defineProperty(document, 'pointerLockElement', {
      get: () => canvas,
      configurable: true,
    });
  });
}

async function approachHut(page, startPos) {
  if (!startPos || distToWall(startPos) <= 14) return;
  for (let step = 0; step < 220; step += 1) {
    const snap = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
    const p = snap.position;
    if (!p || distToWall(p) <= 12) break;
    const dx = DRYWALL_WALL.x - p[0];
    const dz = DRYWALL_WALL.z - p[2];
    const desiredYaw = Math.atan2(-dx, -dz);
    let yawErr = desiredYaw - snap.cameraYaw;
    while (yawErr > Math.PI) yawErr -= Math.PI * 2;
    while (yawErr < -Math.PI) yawErr += Math.PI * 2;
    const mx = Math.max(-35, Math.min(35, (yawErr * 180) / Math.PI));
    await page.evaluate((x) => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { movementX: x, movementY: 0, bubbles: true }),
      );
    }, mx);
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await page.waitForTimeout(180);
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
  }
}

async function main() {
  const matchId = `sheet-sync-${Date.now()}`;
  console.log('matchId', matchId, 'base', BASE, 'headless', HEADLESS);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--enable-quic',
      '--no-sandbox',
      '--window-size=1280,720',
    ],
  });

  const contextA = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const contextB = await browser.newContext({ viewport: { width: 960, height: 720 } });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const consoleErrors = [];
  for (const [label, page] of [
    ['A', pageA],
    ['B', pageB],
  ]) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[${label}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`[${label}] ${err}`));
  }

  await Promise.all([openPlay(pageA, matchId), openPlay(pageB, matchId)]);
  await pageA.screenshot({ path: pathJoin(OUT, '01-a-landing.png') });
  await pageB.screenshot({ path: pathJoin(OUT, '01-b-landing.png') });

  const [snapA, snapB] = await Promise.all([joinMatch(pageA), joinMatch(pageB)]);
  console.log('joined A', snapA.playerId, snapA.transport, 'B', snapB.playerId, snapB.transport);

  await Promise.all([waitForRemote(pageA), waitForRemote(pageB)]);
  await Promise.all([waitForSheetQa(pageA), waitForSheetQa(pageB)]);
  await Promise.all([patchPointerLock(pageA), patchPointerLock(pageB)]);

  await pageA.screenshot({ path: pathJoin(OUT, '02-a-both-joined.png') });
  await pageB.screenshot({ path: pathJoin(OUT, '02-b-both-joined.png') });

  const posA = await pageA.evaluate(() => window.__VIBE_SHEET_QA__.getPosition());
  const posB = await pageB.evaluate(() => window.__VIBE_SHEET_QA__.getPosition());
  const shooterIsA = distToWall(posA) <= distToWall(posB);
  const shooterPage = shooterIsA ? pageA : pageB;
  const observerPage = shooterIsA ? pageB : pageA;
  const shooterLabel = shooterIsA ? 'A' : 'B';
  const observerLabel = shooterIsA ? 'B' : 'A';
  console.log('positions', {
    posA,
    posB,
    distA: distToWall(posA),
    distB: distToWall(posB),
    shooterLabel,
  });

  await approachHut(shooterPage, shooterIsA ? posA : posB);
  await approachHut(observerPage, shooterIsA ? posB : posA);

  const shooterPos = await shooterPage.evaluate(() => window.__VIBE_SHEET_QA__.getPosition());
  console.log('shooter pos after approach', shooterPos, 'dist', distToWall(shooterPos));

  const beforeShooter = await shooterPage.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  const beforeObserver = await observerPage.evaluate(() =>
    window.__VIBE_SHEET_QA__.getCarveCount(),
  );
  console.log('carve before shooter/observer', beforeShooter, beforeObserver);

  for (let i = 0; i < 16; i += 1) {
    const wall = {
      x: DRYWALL_WALL.x + (i % 4) * 0.05,
      y: DRYWALL_WALL.y + Math.floor(i / 4) * 0.06,
      z: DRYWALL_WALL.z,
    };
    const result = await shooterPage.evaluate(
      (w) => window.__VIBE_SHEET_QA__.fireAt(w.x, w.y, w.z),
      wall,
    );
    if (i === 0 || i === 15) console.log('fire', i, result);
    await shooterPage.waitForTimeout(150);
  }

  await observerPage.waitForFunction(
    (minCount) => (window.__VIBE_SHEET_QA__?.getCarveCount?.() ?? 0) > minCount,
    beforeObserver,
    { timeout: 25_000 },
  );
  // Shooter should also accumulate the broadcast CarveEvents.
  await shooterPage.waitForFunction(
    (minCount) => (window.__VIBE_SHEET_QA__?.getCarveCount?.() ?? 0) > minCount,
    beforeShooter,
    { timeout: 10_000 },
  );
  await shooterPage.waitForTimeout(800);

  const afterShooter = await shooterPage.evaluate(() => window.__VIBE_SHEET_QA__.getCarveCount());
  const afterObserver = await observerPage.evaluate(() =>
    window.__VIBE_SHEET_QA__.getCarveCount(),
  );
  const eventsObserver = await observerPage.evaluate(() =>
    window.__VIBE_SHEET_QA__.getCarveEvents(),
  );
  console.log('carve after shooter/observer', afterShooter, afterObserver);

  // Aim camera at the drywall wall using snapshot yaw/pitch feedback.
  async function lookAtWall(page) {
    for (let i = 0; i < 60; i += 1) {
      const snap = await page.evaluate(() => window.__VIBE_E2E__.snapshot());
      const pos = snap.position;
      const dx = DRYWALL_WALL.x - pos[0];
      const dy = DRYWALL_WALL.y - (pos[1] + 0.8);
      const dz = DRYWALL_WALL.z - pos[2];
      const horiz = Math.hypot(dx, dz) || 1;
      // Engine yaw: 0 faces -Z, positive yaw turns right (toward -X).
      const desiredYaw = Math.atan2(-dx, -dz);
      const desiredPitch = Math.atan2(dy, horiz);
      let yawErr = desiredYaw - snap.cameraYaw;
      while (yawErr > Math.PI) yawErr -= Math.PI * 2;
      while (yawErr < -Math.PI) yawErr += Math.PI * 2;
      const pitchErr = desiredPitch - snap.cameraPitch;
      if (Math.abs(yawErr) < 0.04 && Math.abs(pitchErr) < 0.04) break;
      const mx = Math.max(-40, Math.min(40, (yawErr * 180) / Math.PI));
      const my = Math.max(-30, Math.min(30, (-pitchErr * 180) / Math.PI));
      await page.evaluate(
        ([x, y]) => {
          document.dispatchEvent(
            new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true }),
          );
        },
        [mx, my],
      );
      await page.waitForTimeout(30);
    }
  }
  await lookAtWall(shooterPage);
  await lookAtWall(observerPage);
  await shooterPage.waitForTimeout(400);

  await pageA.screenshot({ path: pathJoin(OUT, '03-a-after-carve.png') });
  await pageB.screenshot({ path: pathJoin(OUT, '03-b-after-carve-synced.png') });
  await shooterPage.screenshot({ path: pathJoin(OUT, '03-shooter.png') });
  await observerPage.screenshot({ path: pathJoin(OUT, '03-observer-synced.png') });

  const composite = await browser.newPage({ viewport: { width: 1920, height: 720 } });
  await composite.setContent(`<!doctype html><html><body style="margin:0;background:#111;color:#fff;font-family:sans-serif">
  <div style="display:flex;gap:8px;padding:8px">
    <div style="flex:1"><div style="padding:6px 8px">Shooter (player ${shooterLabel}) — carve events ${afterShooter}</div><img id="a" style="width:100%;background:#222"/></div>
    <div style="flex:1"><div style="padding:6px 8px">Observer (player ${observerLabel}) — synced carve events ${afterObserver}</div><img id="b" style="width:100%;background:#222"/></div>
  </div>
  </body></html>`);
  const aBuf = await shooterPage.screenshot();
  const bBuf = await observerPage.screenshot();
  await composite.evaluate(
    ({ a, b }) => {
      document.getElementById('a').src = a;
      document.getElementById('b').src = b;
    },
    {
      a: `data:image/png;base64,${aBuf.toString('base64')}`,
      b: `data:image/png;base64,${bBuf.toString('base64')}`,
    },
  );
  await composite.waitForTimeout(250);
  await composite.screenshot({ path: pathJoin(OUT, '04-side-by-side.png') });

  const remoteA = await pageA.evaluate(() => window.__VIBE_E2E__.snapshot());
  const remoteB = await pageB.evaluate(() => window.__VIBE_E2E__.snapshot());

  await browser.close();

  const pass =
    snapA.playerId > 0 &&
    snapB.playerId > 0 &&
    snapA.playerId !== snapB.playerId &&
    afterShooter > beforeShooter &&
    afterObserver > beforeObserver &&
    afterObserver >= 1 &&
    (remoteA.remotePlayers?.length ?? 0) >= 1 &&
    (remoteB.remotePlayers?.length ?? 0) >= 1;

  const report = {
    pass,
    matchId,
    shooterLabel,
    observerLabel,
    playerA: { id: snapA.playerId, transport: snapA.transport, position: posA },
    playerB: { id: snapB.playerId, transport: snapB.transport, position: posB },
    carves: {
      beforeShooter,
      afterShooter,
      beforeObserver,
      afterObserver,
      syncedEvents: eventsObserver.length,
      sampleEvent: eventsObserver[0] ?? null,
    },
    remotes: {
      aSees: remoteA.remotePlayers?.length ?? 0,
      bSees: remoteB.remotePlayers?.length ?? 0,
    },
    consoleErrors: consoleErrors.slice(0, 30),
    artifacts: OUT,
  };
  writeFileSync(pathJoin(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
