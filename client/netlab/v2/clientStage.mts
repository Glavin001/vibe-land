/**
 * Netlab v2 client stage: the production client, headless, over a tape.
 *
 *   node --import tsx/esm netlab/v2/clientStage.mts --tape lab.vltape --out <dir>
 *     [--frames recorded|60|120] [--client-root <client dir>] [--label lab]
 *
 * Everything that decides what is drawn is imported from `--client-root`
 * (default: this checkout's client/), so the same lab run against another
 * worktree measures THAT tree's client:
 *
 *   - cityTape.ts `decodeCityTape`       reads the tape (lab or recorded);
 *   - cityReplay.ts `createReplayPlayer` routes every packet exactly as the
 *     transports do (inbound.ts), into the real CityClient and the real
 *     NetcodeClient (replayWorld.ts), at its arrival time;
 *   - the WASM server clock (netcode/src/clock_sync.rs via shared/'s
 *     WasmClockSync) is registered the way sharedPhysics.ts registers it;
 *     the TypeScript fallback is NOT used;
 *   - per frame: NetcodeClient's render clocks and interpolators
 *     (getRenderTimeUs / getDynamicBodyRenderTimeUs / sample* /
 *     getInterpolatedDynamicBodyState -- what GameRuntime draws remote
 *     entities with), meteorPlacement.ts `placeMeteor` (what MeteorLayer
 *     draws meteors with), CityClient.samplePresentation (city chunks).
 *
 * The seams, and why they are faithful, are in docs/netlab-v2.md.
 *
 * Output in --out: displayed.bin (VLDISP01, see displayFormat.ts),
 * presented.bin (VLPRES01 city bodies, zstd), client-stats.json.
 */
import { createWriteStream, existsSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import {
  encodeDisplayFrame,
  encodeDisplayHeader,
  eventOrder,
  FLAG_SAMPLED,
  frameSchedule,
  KIND_BODY,
  KIND_PLAYER,
  KIND_VEHICLE,
  type DisplayedEntity,
} from './displayFormat.ts';

const KIND_METEOR = 4;
const METEOR_SOURCE = { arc: 0, body: 1, hold: 2, hidden: 3 } as Record<string, number>;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const tapePath = resolve(arg('tape'));
const outDir = resolve(arg('out'));
const framesMode = arg('frames', 'recorded');
const clientRoot = resolve(arg('client-root', join(import.meta.dirname, '../..')));
const label = arg('label', 'lab');

// The client's own clock, driven by the tape. Everything that reads
// performance.now() (the city client's arrival stamps and pacing valves)
// reads the tape's time on the recording page's clock.
let fakeNowMs = 0;
(globalThis.performance as { now: () => number }).now = () => fakeNowMs;
// The live page logs through console.info; keep stdout for the summary.
console.info = () => {};

const from = (path: string) => pathToFileURL(join(clientRoot, path)).href;

// ── the WASM server clock, exactly as sharedPhysics.ts registers it ────────
const pkgDir = join(clientRoot, 'src/wasm/pkg');
if (!existsSync(join(pkgDir, 'vibe_land_shared_bg.wasm'))) {
  throw new Error(`${pkgDir} is not built: run \`npm run build:wasm\` in ${clientRoot} (see docs/netlab-v2.md)`);
}
const wasmStaleness = (() => {
  // The pkg must be newer than every source it is built from, or the lab
  // would measure a clock that is not in the tree it claims to measure.
  const built = statSync(join(pkgDir, 'vibe_land_shared_bg.wasm')).mtimeMs;
  const newest = (dir: string): { path: string; mtime: number } => {
    let best = { path: '', mtime: 0 };
    if (!existsSync(dir)) return best;
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
      if (!entry.endsWith('.rs')) continue;
      const mtime = statSync(join(dir, entry)).mtimeMs;
      if (mtime > best.mtime) best = { path: join(dir, entry), mtime };
    }
    return best;
  };
  const sources = [newest(join(clientRoot, '../netcode/src')), newest(join(clientRoot, '../shared/src'))];
  const stale = sources.filter((s) => s.mtime > built);
  return { builtAt: new Date(built).toISOString(), stale: stale.map((s) => s.path) };
})();
if (wasmStaleness.stale.length > 0 && !process.argv.includes('--allow-stale-wasm')) {
  throw new Error(
    `the client WASM in ${pkgDir} is older than ${wasmStaleness.stale.join(', ')}: rebuild it (npm run build:wasm) `
      + 'or pass --allow-stale-wasm',
  );
}
const wasm = await import(from('src/wasm/pkg/vibe_land_shared.js'));
wasm.initSync({ module: readFileSync(join(pkgDir, 'vibe_land_shared_bg.wasm')) });
const interpolation = await import(from('src/net/interpolation.ts'));
interpolation.provideWasmClockSync(wasm.WasmClockSync);

// ── production client modules ──────────────────────────────────────────────
const { decodeCityTape } = await import(from('src/city/cityTape.ts'));
const { createReplayPlayer } = await import(from('src/city/cityReplay.ts'));
const meteorFlightsModule = await import(from('src/vfx/meteorFlights.ts'));
const placementPath = join(clientRoot, 'src/vfx/meteorPlacement.ts');
const meteorPlacement = existsSync(placementPath) ? await import(pathToFileURL(placementPath).href) : null;

const raw = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const header = raw.header as Record<string, unknown> & { clockOriginMs?: number; simHz: number; manifestHash: string; wireVersion: number };
// Put the tape back on the recording page's clock: the live client's local
// time was performance.now(), i.e. tape time + clockOriginMs, and the live
// clock probe was evaluated at exactly clockOriginMs + (float32 frame time).
const originMs = header.clockOriginMs ?? 0;
const times = new Float64Array(raw.times.length);
for (let i = 0; i < times.length; i += 1) times[i] = raw.times[i] + originMs;
const tape = { ...raw, times };

// The manifest: the bundle's city capture holds the one the server used.
const manifestPath = arg('manifest', '');
if (!manifestPath) throw new Error('--manifest <city/manifest.json> is required');
const manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
let totalChunks = 0;
let totalBonds = 0;
for (const structure of manifestJson.structures) {
  totalChunks += structure.chunks.length;
  totalBonds += structure.bonds.length;
}
const assets = {
  manifest: { manifest: manifestJson, hashHex: header.manifestHash, totalChunks, totalBonds },
  decoder: async () => {
    if (header.wireVersion !== 3) return undefined;
    throw new Error('wire v3 tapes are not supported by the client stage yet (docs/netlab-v2.md)');
  },
};

// Server tick timeline (tape clock) from the lab, for the city scorer's
// "current sim tick" of each frame.
const timelinePath = join(outDir, 'timeline.json');
const timeline: Array<[number, number]> = existsSync(timelinePath)
  ? (JSON.parse(readFileSync(timelinePath, 'utf8')).ticks as Array<[number, number]>).map(
      ([tick, endMs]) => [tick, endMs + originMs],
    )
  : [];
function simTickAt(ms: number): number {
  let lo = 0;
  let hi = timeline.length - 1;
  if (hi < 0) return 0;
  if (ms < timeline[0][1]) return timeline[0][0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid][1] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return timeline[lo][0];
}

// ── replay ────────────────────────────────────────────────────────────────
fakeNowMs = times.length > 0 ? times[0] : originMs;
const firstBootstrap = tape.packets.findIndex((p: Uint8Array) => p[0] === 122);
fakeNowMs = firstBootstrap >= 0 ? times[firstBootstrap] : fakeNowMs;
const player = await createReplayPlayer(tape, assets);
const world = player.world;
if (!world) throw new Error('the tape has no game stream (a v1 city-only tape)');
const client = world.client;
const city = player.client;

const recordedFrames = raw.frames ? Float64Array.from(raw.frames.times, (t: number) => t + originMs) : null;
const startMs = player.originMs;
const endMs = times.length > 0 ? times[times.length - 1] : startMs;
// Where in the frame the entities are drawn: at the recorded frame time
// (default), or at `time - cpuMs` (`--frame-start cpu`, an experiment: the
// live frame reads the clocks at its start and the probe at its end).
const frameStart = arg('frame-start', 'probe');
const cpuShift = frameStart === 'cpu' ? 1 : frameStart === 'after' ? -1 : 0;
const frames = frameSchedule(
  framesMode,
  recordedFrames,
  startMs,
  endMs,
  cpuShift !== 0 && raw.frames ? Float32Array.from(raw.frames.cpuMs, (c: number) => c * cpuShift) : null,
);

const displayFile = createWriteStream(join(outDir, 'displayed.bin'));
displayFile.write(encodeDisplayHeader({
  label,
  tape: tapePath,
  clientRoot,
  frames: frames.length,
  framesMode,
  clockOriginMs: originMs,
  clock: 'page (tape ms + clockOriginMs)',
  wasm: { usesWasm: client.serverClock.usesWasm, ...wasmStaleness },
  meteorPlacement: meteorPlacement !== null,
}));

const presentedStream = await (async () => {
  const file = createWriteStream(join(outDir, 'presented.bin'));
  // zstd when this Node has it (>= 22.15); the Rust reader sniffs the frame
  // magic and reads either.
  const zstd = (zlib as unknown as { createZstdCompress?: (o: unknown) => NodeJS.ReadWriteStream }).createZstdCompress;
  const packer: NodeJS.ReadWriteStream = zstd
    ? zstd({ params: { [(zlib.constants as Record<string, number>).ZSTD_c_compressionLevel]: 3 } })
    : new (await import('node:stream')).PassThrough();
  packer.pipe(file);
  const head = Buffer.alloc(20);
  head.write('VLPRES01', 0, 'ascii');
  head.writeUInt32LE(header.simHz, 8);
  const frameHz = frames.length > 1
    ? Math.round((frames.length - 1) / ((frames[frames.length - 1].probeMs - frames[0].probeMs) / 1000))
    : 60;
  head.writeUInt32LE(frameHz, 12);
  head.writeUInt32LE(timeline.length ? timeline[0][0] : 0, 16);
  packer.write(head);
  return {
    write: (chunk: Buffer) => packer.write(chunk),
    end: () => new Promise<void>((done, fail) => {
      file.on('finish', () => done());
      file.on('error', fail);
      packer.end();
    }),
  };
})();
const lastWritten = new Map<number, Float32Array>();
function writePresented(nowMs: number): void {
  const clock = city.presentationClock();
  const changed: number[] = [];
  const poses: Float32Array[] = [];
  const seen = new Set<number>();
  for (const body of city.topology.allBodies()) {
    seen.add(body.key);
    const p = body.position;
    const q = body.rotation;
    const last = lastWritten.get(body.key);
    if (last && last[0] === p[0] && last[1] === p[1] && last[2] === p[2]
      && last[3] === q[0] && last[4] === q[1] && last[5] === q[2] && last[6] === q[3]) continue;
    const stored = last ?? new Float32Array(7);
    stored.set([p[0], p[1], p[2], q[0], q[1], q[2], q[3]]);
    if (!last) lastWritten.set(body.key, stored);
    changed.push(body.key);
    poses.push(stored);
  }
  const retired = [...lastWritten.keys()].filter((key) => !seen.has(key));
  for (const key of retired) lastWritten.delete(key);
  const frame = Buffer.alloc(16 + changed.length * 32 + 4 + retired.length * 4);
  let at = 0;
  frame.writeUInt32LE(simTickAt(nowMs), at); at += 4;
  frame.writeFloatLE(clock.renderTick, at); at += 4;
  frame.writeFloatLE(clock.playoutDelayTicks, at); at += 4;
  frame.writeUInt32LE(changed.length, at); at += 4;
  changed.forEach((key, i) => {
    frame.writeUInt32LE(key, at); at += 4;
    for (let k = 0; k < 7; k += 1) { frame.writeFloatLE(poses[i][k], at); at += 4; }
  });
  frame.writeUInt32LE(retired.length, at); at += 4;
  for (const key of retired) { frame.writeUInt32LE(key, at); at += 4; }
  presentedStream.write(frame);
}

const TICK_US = Math.round(1_000_000 / header.simHz);
let sampled = 0;
let skippedBeforeStart = 0;
const realNow = () => Number(process.hrtime.bigint()) / 1e6;
let clientMs = 0;
const events = eventOrder(times, frames.map((f) => Math.min(f.sampleMs, f.probeMs)));
for (const [what, index] of events) {
  if (what === 'p') {
    const t = times[index];
    if (t <= startMs) continue; // dispatched when the player was created
    fakeNowMs = t;
    const started = realNow();
    player.fastForward(t - startMs);
    clientMs += realNow() - started;
    continue;
  }
  const { sampleMs: t, probeMs } = frames[index];
  if (Math.min(t, probeMs) < startMs) {
    skippedBeforeStart += 1;
    continue;
  }
  const started = realNow();
  // The live clock probe (gameRuntime.ts describeSession.clock), verbatim.
  // It advances the render clock like any other call, so it runs in its
  // place in the frame: before the draw when the draw comes later.
  let probe: { offsetUs: number; dynDelayMs: number } | null = null;
  const runProbe = () => {
    fakeNowMs = probeMs;
    player.fastForward(probeMs - startMs);
    const probeUs = probeMs * 1000;
    const probeRenderUs = client.getDynamicBodyRenderTimeUs(probeUs);
    const dynDelayMs = client.dynamicBodyInterpolationDelayMs;
    probe = { offsetUs: probeRenderUs + dynDelayMs * 1000 - probeUs, dynDelayMs };
  };
  if (probeMs < t) runProbe();
  fakeNowMs = t;
  player.fastForward(t - startMs);
  const localUs = t * 1000;
  const renderUs = client.getRenderTimeUs(localUs);
  const dynRenderUs = client.getDynamicBodyRenderTimeUs(localUs);
  const entities: DisplayedEntity[] = [];
  for (const id of client.remotePlayers.keys()) {
    const sample = client.sampleRemotePlayer(id, renderUs);
    const latest = client.remotePlayers.get(id)!;
    const position = sample?.position ?? latest.position;
    entities.push({
      kind: KIND_PLAYER,
      flags: sample ? FLAG_SAMPLED : 0,
      id,
      position,
      quaternion: [sample?.yaw ?? latest.yaw, sample?.pitch ?? latest.pitch, 0, 0],
      ageMs: Number.NaN,
    });
  }
  for (const [id, latest] of client.vehicles) {
    const sample = client.sampleRemoteVehicle(id, renderUs);
    entities.push({
      kind: KIND_VEHICLE,
      flags: sample ? FLAG_SAMPLED : 0,
      id,
      position: sample?.position ?? latest.position,
      quaternion: sample?.quaternion ?? latest.quaternion,
      ageMs: client.getVehicleObservedAgeMs(id, localUs) ?? Number.NaN,
    });
  }
  for (const id of client.dynamicBodies.keys()) {
    // DynamicBodiesRenderer (netEntityRenderers.ts) skips meteor bodies: the
    // meteor layer draws them (below).
    if (meteorFlightsModule.isMeteorBody(id)) continue;
    const sampled_ = client.sampleRemoteDynamicBody(id, dynRenderUs);
    const drawn = client.getInterpolatedDynamicBodyState(id);
    if (!drawn) continue;
    entities.push({
      kind: KIND_BODY,
      flags: sampled_ ? FLAG_SAMPLED : 0,
      id,
      position: drawn.position,
      quaternion: drawn.quaternion,
      ageMs: client.getDynamicBodyObservedAgeMs(id, localUs) ?? Number.NaN,
    });
  }
  // Meteors, as MeteorLayer places them (meteorPlacement.ts).
  if (meteorPlacement) {
    const flights = meteorFlightsModule.meteorFlights(t, dynRenderUs);
    for (const flight of flights) {
      const placed = meteorPlacement.placeMeteor(flight, flight.track, {
        renderServerUs: dynRenderUs,
        samples: client.getDynamicBodySamples(flight.bodyId),
        ticksSinceSeen: client.getDynamicBodyTicksSinceSeen(flight.bodyId),
        tickUs: TICK_US,
        nowMs: t,
      });
      entities.push({
        kind: KIND_METEOR,
        flags: METEOR_SOURCE[placed.source] ?? 255,
        id: flight.bodyId,
        position: placed.position,
        quaternion: placed.quaternion ?? [0, 0, 0, 1],
        ageMs: Number.NaN,
      });
    }
  }
  city.samplePresentation(t);
  if (!probe) runProbe();
  const { offsetUs, dynDelayMs } = probe!;
  clientMs += realNow() - started;
  displayFile.write(encodeDisplayFrame({
    tMs: probeMs,
    sampleMs: t,
    offsetUs,
    interpDelayMs: client.interpolationDelayMs,
    dynDelayMs,
    renderUs,
    dynRenderUs,
    entities,
  }));
  writePresented(t);
  sampled += 1;
}
await new Promise<void>((done, fail) => {
  displayFile.end(() => done());
  displayFile.on('error', fail);
});
await presentedStream.end();

const stats = {
  label,
  tape: tapePath,
  clientRoot,
  framesMode,
  framesSampled: sampled,
  framesBeforeCityBootstrap: skippedBeforeStart,
  packets: times.length,
  decodeErrors: world.decodeErrors,
  usesWasmClock: client.serverClock.usesWasm,
  serverWallClock: client.serverClock.hasServerWallClock?.() ?? null,
  wasm: wasmStaleness,
  meteorPlacement: meteorPlacement !== null,
  clientCpuMs: +clientMs.toFixed(1),
  city: city.stats(),
};
writeFileSync(join(outDir, 'client-stats.json'), JSON.stringify(stats, null, 1));
console.log(JSON.stringify({
  label,
  framesSampled: sampled,
  decodeErrors: world.decodeErrors,
  usesWasmClock: stats.usesWasmClock,
  nacksSent: stats.city.nacksSent,
  resyncRequestsSent: stats.city.resyncRequestsSent,
  topoSeqGaps: stats.city.topoSeqGaps,
}));
