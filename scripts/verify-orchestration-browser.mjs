#!/usr/bin/env node
/**
 * End-to-end proof, from a real browser.
 *
 * Loads the game client pointed at the control plane and asserts that the
 * browser: asks the control plane where to play, receives an address plus a
 * certificate hash, and completes a WebTransport handshake to the GPU server
 * using that hash. That handshake is the one thing no unit test can stand in
 * for -- it is where a wrong certificate, a wrong port, or a blocked UDP path
 * would show up.
 *
 *   node scripts/verify-orchestration-browser.mjs [clientUrl] [controlPlaneUrl]
 */

import { createRequire } from 'node:module';

// Playwright is a client-side dev dependency and this script lives outside that
// package, so resolve it from the client's node_modules explicitly.
const require = createRequire(new URL('../client/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const CLIENT_URL = process.argv[2] ?? 'http://127.0.0.1:9000';
const CONTROL_PLANE = process.argv[3] ?? 'http://127.0.0.1:9001';
const TIMEOUT_MS = 90_000;

const target = `${CLIENT_URL}/city?controlPlane=${encodeURIComponent(CONTROL_PLANE)}&portal=true`;

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    // The GPU server presents a short-lived self-signed certificate. Chrome
    // accepts it through `serverCertificateHashes`, which is exactly the
    // mechanism under test -- no certificate-ignoring flags here, or the test
    // would pass even when the hash is wrong.
    '--enable-features=WebTransport',
  ],
});

const page = await browser.newPage();
const logs = [];
page.on('console', (message) => {
  const text = message.text();
  logs.push(text);
  if (/webtransport|netcode|join|city/i.test(text)) {
    console.log(`  [browser] ${text.slice(0, 180)}`);
  }
});
page.on('pageerror', (error) => logs.push(`PAGEERROR ${error.message}`));

console.log(`[verify] opening ${target}`);
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });

const deadline = Date.now() + TIMEOUT_MS;
let connected = false;
let failure = null;

while (Date.now() < deadline) {
  if (logs.some((line) => /connected via WebTransport/i.test(line))) {
    connected = true;
    break;
  }
  const failed = logs.find((line) =>
    /WebTransport failed|WebSocket fallback is unavailable|control plane returned HTTP/i.test(line),
  );
  if (failed) {
    failure = failed;
    break;
  }
  await page.waitForTimeout(500);
}

// Independently confirm the fleet sees the player, rather than trusting the
// client's own account of the handshake. This matters beyond bookkeeping: idle
// shutdown keys on the player count, so a count stuck at zero would destroy
// boxes out from under people who are playing on them.
const admin = { Authorization: `Bearer ${process.env.ADMIN_TOKEN ?? 'dev-admin-token'}` };
const readFleet = () =>
  fetch(`${CONTROL_PLANE}/fleet`, { headers: admin }).then((response) => response.json());

let fleet = await readFleet();
let sawPlayer = false;
if (connected) {
  // Heartbeats are 30 s apart, so allow two intervals before calling it stuck.
  const playerDeadline = Date.now() + 70_000;
  while (Date.now() < playerDeadline) {
    fleet = await readFleet();
    if ((fleet.servers ?? []).some((row) => row.players > 0)) {
      sawPlayer = true;
      break;
    }
    await page.waitForTimeout(2000);
  }
}

await browser.close();

console.log('\n[verify] fleet after connect:', JSON.stringify(fleet.servers, null, 2));

if (!connected) {
  console.error(`\n[verify] FAILED: ${failure ?? 'no WebTransport connection within timeout'}`);
  console.error('[verify] last browser logs:');
  for (const line of logs.slice(-25)) console.error(`   ${line.slice(0, 200)}`);
  process.exit(1);
}

const server = fleet.servers?.find((row) => row.phase === 'READY');
if (!sawPlayer) {
  console.error('\n[verify] FAILED: the fleet never saw the connected player.');
  console.error('[verify] Idle shutdown keys on this count, so it would reap a box mid-game.');
  process.exit(1);
}

console.log('\n[verify] PASS: browser connected over WebTransport via the control plane');
console.log(`[verify] fleet reported players=${server?.players} matches=${server?.activeMatches}`);
