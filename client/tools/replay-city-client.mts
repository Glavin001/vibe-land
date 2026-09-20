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
 *   npx tsx tools/replay-city-client.mts --packets <dir> --bodies-out <presented.bin> [--frame-hz 60] [--impair lte]
 *
 * `--bodies-out` writes what the client would display per BODY (the island
 * centre-of-mass frame the stream carries), one frame per render tick, as a
 * VLPRES01 stream the netlab scorer compares against the encoder tape's
 * truth. `--out` (per-chunk TWSTATE1) needs the recorder's state-header.bin
 * and is optional when `--bodies-out` is given.
 *
 * This exists because hand-written Rust "client models" in the recorder
 * diverged from the shipping client three separate ways (topology timing,
 * lane healing, support-COM convention), and every divergence read as a codec
 * defect on video when the product had none of it.
 */
import { createWriteStream, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
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

function optionalArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const packetsDir = arg('--packets');
const outPath = optionalArg('--out');
const bodiesOutPath = optionalArg('--bodies-out');
if (!outPath && !bodiesOutPath) {
  throw new Error('need --out <towerstate> and/or --bodies-out <presented.bin>');
}
const frameHzArg = optionalArg('--frame-hz');
// Optional link impairment, applied the way WebTransport actually behaves:
// datagrams ('d') suffer loss, delay, jitter and reordering; the reliable
// channel ('r') is delayed but never lost and never reordered (QUIC
// retransmits under the hood -- modelled as latency, not loss). Profiles
// come from the same table netlab uses, seeded for reproducibility.
const impairName = process.argv.includes('--impair')
  ? process.argv[process.argv.indexOf('--impair') + 1]
  : null;

const meta = JSON.parse(readFileSync(join(packetsDir, 'meta.json'), 'utf8')) as {
  hz: number;
  ticks: number;
  wire: number;
  first_tick?: number;
  last_tick?: number;
};
// A live capture's ticks start wherever the server's counter was; the
// recorder's start at 0. Delivery ticks in the log are absolute either way.
const firstTick = meta.first_tick ?? 0;
const lastTick = meta.last_tick ?? firstTick + meta.ticks - 1;
// The manifest sits beside the recorder's packets; a multi-client replay
// keeps one copy at the capture root and names it.
const manifestPath = optionalArg('--manifest') ?? join(packetsDir, 'manifest.json');
const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
let totalChunks = 0;
let totalBonds = 0;
for (const structure of manifestJson.structures) {
  totalChunks += structure.chunks.length;
  totalBonds += structure.bonds.length;
}

// Packets grouped by DELIVERY tick. Without impairment that is the send
// tick in send order; with it, datagrams are dropped/delayed/reordered and
// reliable packets are delayed in order.
const byTick = new Map<number, Array<{ seq: number; bytes: Uint8Array }>>();
{
  let profile: { delayMs: number; jitterMs: number; lossPct: number; reorderPct?: number } | null =
    null;
  if (impairName) {
    const profiles = JSON.parse(
      readFileSync(join(here, '../netlab/netemProfiles.json'), 'utf8'),
    ).profiles;
    profile = profiles[impairName];
    if (!profile) throw new Error(`unknown impair profile ${impairName}`);
  }
  // mulberry32: tiny seeded RNG so an impaired replay is reproducible.
  let rngState = 0x9e3779b9;
  const rng = (): number => {
    rngState |= 0;
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const msToTicks = (ms: number): number => Math.round((ms / 1000) * meta.hz);
  let reliableFront = 0; // enforces in-order reliable delivery
  let seq = 0;
  for (const line of readFileSync(join(packetsDir, 'packets.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { tick: number; chan: string; hex: string };
    let deliverAt = entry.tick;
    if (profile) {
      const jitter = (rng() * 2 - 1) * profile.jitterMs;
      if (entry.chan === 'd') {
        if (rng() * 100 < profile.lossPct) {
          seq += 1;
          continue; // lost datagram: nobody retransmits it
        }
        let delay = profile.delayMs + jitter;
        if (profile.reorderPct && rng() * 100 < profile.reorderPct) {
          delay += profile.jitterMs * 3; // a straggler, delivered out of order
        }
        deliverAt = entry.tick + Math.max(0, msToTicks(delay));
      } else {
        deliverAt = entry.tick + Math.max(0, msToTicks(profile.delayMs + jitter));
        // Ordered stream: never before anything already queued on it.
        deliverAt = Math.max(deliverAt, reliableFront);
        reliableFront = deliverAt;
      }
    }
    let list = byTick.get(deliverAt);
    if (!list) {
      list = [];
      byTick.set(deliverAt, list);
    }
    list.push({ seq, bytes: hexToBytes(entry.hex) });
    seq += 1;
  }
  // Within a tick keep send order for determinism (reordering is expressed
  // through delivery-tick differences, as on a real link).
  for (const list of byTick.values()) list.sort((a, b) => a.seq - b.seq);
}

// Wire 3 needs the wasm debris decoder; wire 2 uses the client's ranked-record
// path, and passing no decoder is exactly how the browser runs a v2 match.
let v3: { decoder: InstanceType<typeof DebrisDecoder>; simHz: number } | undefined;
if (meta.wire === 3) {
  await initDebris(readFileSync(join(here, '../src/wasm/debris-pkg/destruction_codec_bg.wasm')));
  const dictionary = readFileSync(join(here, '../src/city/city-packet-v3.dict'));
  v3 = {
    decoder: new DebrisDecoder(new Uint8Array(dictionary), 1 << 16, meta.hz),
    simHz: meta.hz,
  };
}

// Real wall-clock for measuring the client's own work; the faked
// performance.now above is SIM time and must not leak into cost numbers.
const realNowMs = () => Number(process.hrtime.bigint()) / 1e6;
const clientMsPerSecond: number[] = [];
const decodeMsPerSecond: number[] = [];
const sampleMsPerSecond: number[] = [];
const sampleMsPerFrame: number[] = [];
function chargeClientMs(second: number, ms: number, bucket: number[]): void {
  while (clientMsPerSecond.length <= second) clientMsPerSecond.push(0);
  while (bucket.length <= second) bucket.push(0);
  clientMsPerSecond[second] += ms;
  bucket[second] += ms;
}

let nacks = 0;
const client = new CityClient(
  { manifest: manifestJson, hashHex: 'offline', totalChunks, totalBonds },
  () => {
    // Lossless offline stream: a nack here indicates a real defect. Counted,
    // not healed -- there is no server to heal from.
    nacks += 1;
  },
  v3,
);

// --- TWSTATE1 output: recorded header + frame records + terminator --------
const out = outPath ? createWriteStream(outPath) : null;
let expectedFrames = 0;
if (out && outPath) {
  const headerBytes = readFileSync(join(packetsDir, 'state-header.bin'));
  out.write(headerBytes);
  expectedFrames = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength,
  ).getUint32(16, true);
}

const msPerTick = 1000 / meta.hz;
const frameHz = frameHzArg ? Number(frameHzArg) : outPath ? 30 : 60;
const viewStep = Math.max(1, Math.floor(meta.hz / frameHz));
let framesWritten = 0;

function writeFrame(): void {
  if (!out) return;
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

// --- VLPRES01: per-frame presented BODY poses, changed bodies only --------
//
// Every body the ledger holds is compared against what was last written, so
// a pose that reached the ledger by any path -- the sampled track, a settle,
// a promotion, a bootstrap, a structure repair -- is captured, and a body
// that is gone from the ledger is reported retired. The scorer holds poses
// forward between changes.
// zstd-framed: at ten thousand moving bodies a frame is 300 KB and a
// minute is a gigabyte per client. The Rust reader sniffs the frame magic.
const bodiesOut = bodiesOutPath
  ? (() => {
      const { createZstdCompress } = zlib;
      const file = createWriteStream(bodiesOutPath);
      const packer = createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
      packer.pipe(file);
      return { write: (chunk: Buffer) => packer.write(chunk), end: () => new Promise<void>((resolve, reject) => {
        file.on('finish', () => resolve());
        file.on('error', reject);
        packer.end();
      }) };
    })()
  : null;
const lastWritten = new Map<number, Float32Array>();
let presentedFrames = 0;
let presentedRecords = 0;
if (bodiesOut) {
  const header = Buffer.alloc(8 + 4 + 4 + 4);
  header.write('VLPRES01', 0, 'ascii');
  header.writeUInt32LE(meta.hz, 8);
  header.writeUInt32LE(frameHz, 12);
  header.writeUInt32LE(firstTick, 16);
  bodiesOut.write(header);
}
const scratch = new Float32Array(7);
function writePresentedFrame(simTickNow: number): void {
  if (!bodiesOut) return;
  const clock = client.presentationClock();
  const changed: number[] = [];
  const poses: Float32Array[] = [];
  const seen = new Set<number>();
  for (const body of client.topology.allBodies()) {
    seen.add(body.key);
    const p = body.position;
    const q = body.rotation;
    const last = lastWritten.get(body.key);
    if (
      last
      && last[0] === p[0] && last[1] === p[1] && last[2] === p[2]
      && last[3] === q[0] && last[4] === q[1] && last[5] === q[2] && last[6] === q[3]
    ) {
      continue;
    }
    const stored = last ?? new Float32Array(7);
    stored[0] = p[0]; stored[1] = p[1]; stored[2] = p[2];
    stored[3] = q[0]; stored[4] = q[1]; stored[5] = q[2]; stored[6] = q[3];
    if (!last) lastWritten.set(body.key, stored);
    changed.push(body.key);
    poses.push(stored);
  }
  const retired: number[] = [];
  for (const key of lastWritten.keys()) {
    if (!seen.has(key)) retired.push(key);
  }
  for (const key of retired) lastWritten.delete(key);
  const frame = Buffer.alloc(4 + 4 + 4 + 4 + changed.length * 32 + 4 + retired.length * 4);
  let at = 0;
  frame.writeUInt32LE(simTickNow, at); at += 4;
  frame.writeFloatLE(clock.renderTick, at); at += 4;
  frame.writeFloatLE(clock.playoutDelayTicks, at); at += 4;
  frame.writeUInt32LE(changed.length, at); at += 4;
  for (let index = 0; index < changed.length; index += 1) {
    frame.writeUInt32LE(changed[index], at); at += 4;
    const pose = poses[index];
    for (let k = 0; k < 7; k += 1) {
      frame.writeFloatLE(pose[k], at); at += 4;
    }
  }
  frame.writeUInt32LE(retired.length, at); at += 4;
  for (const key of retired) {
    frame.writeUInt32LE(key, at); at += 4;
  }
  bodiesOut.write(frame);
  presentedFrames += 1;
  presentedRecords += changed.length;
  void scratch;
}

// Frame 0 mirrors the Rust models: bootstrap state before any packet.
// (The bootstrap packet itself arrives at tick 0 below.)
writeFrame();

for (let tick = firstTick; tick <= lastTick; tick += 1) {
  fakeNowMs = (tick - firstTick) * msPerTick;
  const second = Math.floor((tick - firstTick) / meta.hz);
  for (const { bytes } of byTick.get(tick) ?? []) {
    const started = realNowMs();
    client.handlePacket(bytes);
    chargeClientMs(second, realNowMs() - started, decodeMsPerSecond);
  }
  if ((tick - firstTick) % viewStep === 0 && tick > firstTick) {
    const started = realNowMs();
    client.samplePresentation(fakeNowMs);
    const sampleMs = realNowMs() - started;
    chargeClientMs(second, sampleMs, sampleMsPerSecond);
    sampleMsPerFrame.push(sampleMs);
    writeFrame();
    writePresentedFrame(tick);
  }
}

if (out) {
  out.write(Buffer.from([255]));
  await new Promise((resolve, reject) => {
    out.end(() => resolve(undefined));
    out.on('error', reject);
  });
}
if (bodiesOut) {
  await bodiesOut.end();
}

const { writeFileSync } = await import('node:fs');
const percentile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))];
};
const totalClientMs = clientMsPerSecond.reduce((a, b) => a + b, 0);
const stats = client.stats();
const timings = {
  hz: meta.hz,
  frameHz,
  firstTick,
  lastTick,
  clientMsPerSecond: clientMsPerSecond.map((v) => +v.toFixed(3)),
  decodeMsPerSecond: decodeMsPerSecond.map((v) => +v.toFixed(3)),
  sampleMsPerSecond: sampleMsPerSecond.map((v) => +v.toFixed(3)),
  sampleMsPerFrame: {
    frames: sampleMsPerFrame.length,
    p50: +percentile(sampleMsPerFrame, 0.5).toFixed(4),
    p95: +percentile(sampleMsPerFrame, 0.95).toFixed(4),
    max: +percentile(sampleMsPerFrame, 1).toFixed(4),
  },
  clientMsAvgPerSecond: +(totalClientMs / Math.max(1, clientMsPerSecond.length)).toFixed(3),
  presentedFrames,
  presentedRecords,
  nacks,
  stats,
};
const statsPath = bodiesOutPath ? `${bodiesOutPath}.stats.json` : `${outPath}.timings.json`;
writeFileSync(statsPath, JSON.stringify(timings));

console.log(
  JSON.stringify({
    framesWritten,
    expectedFrames,
    presentedFrames,
    presentedRecords,
    nacks,
    wireVersion: stats.wireVersion,
    topoSeqGaps: stats.topoSeqGaps,
    orphanedChunks: stats.orphanedChunks,
    brokenBonds: stats.brokenBonds,
    correctionSnaps: stats.correctionSnaps,
    implausibleJumps: stats.implausibleJumps,
    clockRollbacks: stats.clockRollbacks,
    sampleDelayTicks: stats.sampleDelayTicks,
    clientMsAvgPerSecond: timings.clientMsAvgPerSecond,
    sampleMsP95: timings.sampleMsPerFrame.p95,
  }),
);
if (out && framesWritten !== expectedFrames) {
  console.error(`frame count mismatch: wrote ${framesWritten}, header says ${expectedFrames}`);
  process.exit(1);
}
