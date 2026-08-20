/**
 * Replay a recorded packet stream through the REAL city client.
 *
 * `record-city-trace --packets-out <dir>` dumps the exact client-bound bytes
 * (bootstrap, topology, lane assignments, debris datagrams) plus the manifest
 * and a TWSTATE1 header. This script feeds those bytes through the same
 * `CityClient` + wasm decoder the browser executes -- fix for fix, one
 * implementation -- and writes what the client would DISPLAY as a renderable
 * towerstate:
 *
 *   npx tsx tools/replay-city-client.mts --packets <dir> --out <towerstate>
 *
 * This exists because hand-written Rust "client models" in the recorder
 * diverged from the shipping client three separate ways (topology timing,
 * lane healing, support-COM convention), and every divergence read as a codec
 * defect on video when the product had none of it.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Deterministic clock: the client reads performance.now() for pacing
// (topology valve, byte windows). Drive it from the sim tick.
let fakeNowMs = 0;
(globalThis.performance as { now: () => number }).now = () => fakeNowMs;

const initDebris = (await import('../src/wasm/debris-pkg/destruction_codec.js')).default;
const { DebrisDecoder } = await import('../src/wasm/debris-pkg/destruction_codec.js');
const { CityClient } = await import('../src/city/cityClient.ts');

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`missing ${name} <value>`);
  }
  return process.argv[index + 1];
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

const packetsDir = arg('--packets');
const outPath = arg('--out');

const meta = JSON.parse(readFileSync(join(packetsDir, 'meta.json'), 'utf8')) as {
  hz: number;
  ticks: number;
  wire: number;
};
const manifestJson = JSON.parse(readFileSync(join(packetsDir, 'manifest.json'), 'utf8'));
let totalChunks = 0;
let totalBonds = 0;
for (const structure of manifestJson.structures) {
  totalChunks += structure.chunks.length;
  totalBonds += structure.bonds.length;
}

// Packets grouped by tick, preserving file (= send) order within a tick.
const byTick = new Map<number, Uint8Array[]>();
for (const line of readFileSync(join(packetsDir, 'packets.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const entry = JSON.parse(line) as { tick: number; chan: string; hex: string };
  let list = byTick.get(entry.tick);
  if (!list) {
    list = [];
    byTick.set(entry.tick, list);
  }
  list.push(hexToBytes(entry.hex));
}

await initDebris(readFileSync(join(here, '../src/wasm/debris-pkg/destruction_codec_bg.wasm')));
const dictionary = readFileSync(join(here, '../src/city/city-packet-v3.dict'));
const decoder = new DebrisDecoder(new Uint8Array(dictionary), 1 << 16, meta.hz);

let nacks = 0;
const client = new CityClient(
  { manifest: manifestJson, hashHex: 'offline', totalChunks, totalBonds },
  () => {
    // Lossless offline stream: a nack here indicates a real defect. Counted,
    // not healed -- there is no server to heal from.
    nacks += 1;
  },
  { decoder, simHz: meta.hz },
);

// --- TWSTATE1 output: recorded header + frame records + terminator --------
const headerBytes = readFileSync(join(packetsDir, 'state-header.bin'));
const out = createWriteStream(outPath);
out.write(headerBytes);
const expectedFrames = new DataView(
  headerBytes.buffer,
  headerBytes.byteOffset,
  headerBytes.byteLength,
).getUint32(16, true);

const msPerTick = 1000 / meta.hz;
const viewStep = Math.max(1, Math.floor(meta.hz / 30));
let framesWritten = 0;

function writeFrame(): void {
  const count = client.topology.chunkCount;
  const frame = Buffer.alloc(1 + 4 + 4 + count * (4 + 28 + 1));
  let at = 0;
  frame.writeUInt8(2, at);
  at += 1;
  frame.writeUInt32LE(framesWritten, at);
  at += 4;
  frame.writeUInt32LE(count, at);
  at += 4;
  for (let slot = 0; slot < count; slot += 1) {
    const pose = client.topology.chunkWorldPose(slot);
    frame.writeUInt32LE(slot, at);
    at += 4;
    frame.writeFloatLE(pose.position[0], at);
    frame.writeFloatLE(pose.position[1], at + 4);
    frame.writeFloatLE(pose.position[2], at + 8);
    frame.writeFloatLE(pose.rotation[0], at + 12);
    frame.writeFloatLE(pose.rotation[1], at + 16);
    frame.writeFloatLE(pose.rotation[2], at + 20);
    frame.writeFloatLE(pose.rotation[3], at + 24);
    at += 28;
    frame.writeUInt8(0, at);
    at += 1;
  }
  out.write(frame);
  framesWritten += 1;
}

// Frame 0 mirrors the Rust models: bootstrap state before any packet.
// (The bootstrap packet itself arrives at tick 0 below.)
writeFrame();

for (let tick = 0; tick < meta.ticks; tick += 1) {
  fakeNowMs = tick * msPerTick;
  for (const bytes of byTick.get(tick) ?? []) {
    client.handlePacket(bytes);
  }
  if (tick % viewStep === 0 && tick > 0) {
    client.samplePresentation(fakeNowMs);
    writeFrame();
  }
}

out.write(Buffer.from([255]));
await new Promise((resolve, reject) => {
  out.end(() => resolve(undefined));
  out.on('error', reject);
});

const stats = client.stats();
console.log(
  JSON.stringify({
    framesWritten,
    expectedFrames,
    nacks,
    wireVersion: stats.wireVersion,
    topoSeqGaps: stats.topoSeqGaps,
    orphanedChunks: stats.orphanedChunks,
    brokenBonds: stats.brokenBonds,
  }),
);
if (framesWritten !== expectedFrames) {
  console.error(`frame count mismatch: wrote ${framesWritten}, header says ${expectedFrames}`);
  process.exit(1);
}
