#!/usr/bin/env node
/**
 * Verify the Safari uplink: datagrams down, control stream up.
 *
 * Safari implements WebTransport datagram receive but not send. Rather than
 * demoting those sessions to WebSocket -- surrendering UDP in both directions
 * over a limitation that only affects the client's tiny uplink -- the client
 * keeps the downlink on datagrams and sends input over the control stream.
 *
 * `?uplink=stream` forces that path on any browser, so it can be tested here.
 * The assertion that matters is not "it connected" but "the server acted on
 * input that arrived over the stream": a silently ignored uplink would look
 * identical to a working one from the client's side.
 *
 *   node scripts/verify-stream-uplink.mjs [clientUrl] [controlPlaneUrl]
 */

import { createRequire } from 'node:module';

const require = createRequire(new URL('../client/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const CLIENT_URL = process.argv[2] ?? 'http://127.0.0.1:5556';
const CONTROL_PLANE = process.argv[3] ?? 'http://127.0.0.1:9001';
const admin = { Authorization: `Bearer ${process.env.ADMIN_TOKEN ?? 'dev-admin-token'}` };

const target = `${CLIENT_URL}/city?controlPlane=${encodeURIComponent(CONTROL_PLANE)}&portal=true&uplink=stream`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (message) => logs.push(message.text()));

console.log(`[verify] opening ${target}`);
await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });

const deadline = Date.now() + 90_000;
let connected = false;
while (Date.now() < deadline) {
  if (logs.some((line) => /connected via WebTransport/i.test(line))) {
    connected = true;
    break;
  }
  if (logs.some((line) => /falling back to WebSocket|fallback is unavailable/i.test(line))) break;
  await page.waitForTimeout(500);
}

const usedStream = logs.some((line) => /datagram send unavailable/i.test(line));
const welcomed = logs.some((line) => /Welcome received/i.test(line));

// Drive real input so the uplink carries traffic, then ask the server what it
// saw. The server is the only honest witness: an uplink that is silently
// dropped looks exactly like a working one from the client's side.
const fleet = await fetch(`${CONTROL_PLANE}/fleet`, { headers: admin }).then((r) => r.json());
const server = (fleet.servers ?? []).find((row) => row.phase === 'READY');
const matchId = server ? `city-${server.serverDoId.slice(0, 8)}` : null;
const statsUrl = server ? `http://127.0.0.1:4001/match-stats/${matchId}` : null;

const sampleMe = async () => {
  if (!statsUrl) return null;
  const stats = await fetch(statsUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const players = stats?.players ?? [];
  // The most recently joined WebTransport player is this browser.
  return players.filter((p) => p.transport === 'webtransport').pop() ?? null;
};

let before = null;
let after = null;
if (connected) {
  await page.waitForTimeout(1500);
  before = await sampleMe();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500);
  after = await sampleMe();
}

await browser.close();

const inputsSeen = (after?.last_received_input_seq ?? 0) - (before?.last_received_input_seq ?? 0);
const moved = before && after
  ? Math.hypot(after.pos_m[0] - before.pos_m[0], after.pos_m[2] - before.pos_m[2])
  : 0;
console.log(`  match                : ${matchId ?? 'unknown'}`);
console.log(`  input packets applied: ${inputsSeen}`);
console.log(`  distance moved       : ${moved.toFixed(2)} m`);

console.log(`  transport            : ${connected ? 'WebTransport' : 'NOT WebTransport'}`);
console.log(`  uplink               : ${usedStream ? 'control stream (Safari path)' : 'datagrams'}`);
console.log(`  welcome received     : ${welcomed}`);
console.log(`  server sees players  : ${server?.players ?? 0}`);

const problems = [];
if (!connected) problems.push('did not connect over WebTransport (fell back to WebSocket)');
if (!usedStream) problems.push('did not take the forced stream uplink');
if (!welcomed) problems.push('never received Welcome');
if (!server || server.players < 1) problems.push('server never registered the player');
if (inputsSeen <= 0) problems.push('server received no input over the stream uplink');
if (moved < 0.5) problems.push(`player did not move (${moved.toFixed(2)} m) — input was not applied`);

if (problems.length) {
  console.error(`\n[verify] FAILED: ${problems.join('; ')}`);
  for (const line of logs.slice(-20)) console.error(`   ${line.slice(0, 180)}`);
  process.exit(1);
}
console.log('\n[verify] PASS: WebTransport retained with datagram downlink + stream uplink');
