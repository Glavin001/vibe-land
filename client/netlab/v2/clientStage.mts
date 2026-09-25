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

import { openChunkStream } from './chunkFormat.ts';
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
// Negative control only (docs/netlab-v2.md "Calibration"): `--perturb
// player=0.5,body=0.5,chunk_island=0.5,...` shifts what is recorded as drawn
// by that many metres in x per class (player, vehicle, body, meteor,
// chunk_intact, chunk_island), so a test can check the scorer catches a wrong
// client in every class. Never set for a measurement; the display header
// records it.
const perturb: Record<string, number> = Object.fromEntries(
  arg('perturb', '').split(',').filter(Boolean).map((kv) => {
    const [k, v] = kv.split('=');
    return [k.trim(), Number(v)];
  }),
);
const shift = (entity: DisplayedEntity): DisplayedEntity => {
  const name = ({ 1: 'player', 2: 'vehicle', 3: 'body', 4: 'meteor' } as Record<number, string>)[entity.kind];
  const dx = perturb[name] ?? 0;
  if (!dx) return entity;
  return { ...entity, position: [entity.position[0] + dx, entity.position[1], entity.position[2]] };
};

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
// The renderers' pose steps (docs/netlab-v2.md seam S10). A client tree that
// predates them is measured through the replicated glue below and flagged in
// the display header (`sharedPoses: false`).
const optional = async (path: string) => (existsSync(join(clientRoot, path)) ? import(from(path)) : null);
const entityPoses = await optional('src/scene/netEntityPoses.ts');
const cityPoses = await optional('src/city/cityPoseStore.ts');
// The tick length the client under test puts snapshot times on, so its render
// clocks: protocol.ts SERVER_TICK_US (the server's 16 666 us at 60 Hz), or
// for a tree before it, the 16 667 its SnapshotV2 decoder used. The scorer
// turns render times into truth ticks with it (score.rs).
const protocolModule = await import(from('src/net/protocol.ts'));

const raw = decodeCityTape(new Uint8Array(readFileSync(tapePath)));
const header = raw.header as Record<string, unknown> & { clockOriginMs?: number; simHz: number; manifestHash: string; wireVersion: number };
const TICK_US: number = typeof protocolModule.SERVER_TICK_US === 'number'
  ? protocolModule.SERVER_TICK_US
  : Math.round(1_000_000 / header.simHz);
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
  serverTickUs: TICK_US,
  wasm: { usesWasm: client.serverClock.usesWasm, ...wasmStaleness },
  meteorPlacement: meteorPlacement !== null,
  sharedPoses: { entities: entityPoses !== null, city: cityPoses !== null, meteorFrame: typeof meteorPlacement?.placeMeteorInFrame === 'function' },
  perturb,
  // Every entity record carries the lead it was drawn at past the frame's
  // render time (displayFormat.ts): 0 for players and vehicles, and for any
  // client without a body lead.
  entityLeadUs: true,
  bodyLead: typeof client.dynamicBodyLeadConfig === 'function' ? client.dynamicBodyLeadConfig() : null,
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

// ── city chunks as CityChunksLayer draws them ─────────────────────────────
// The layer's pose tables (cityPoseStore.ts), advanced every frame by the
// layer's own step (`advanceCityPoses`, the distance stride left out: it is a
// render-rate choice that lands on the same pose). What changed in the tables
// is written to drawn-chunks.bin (VLCHNK01, gzip; see chunkFormat.ts); the
// scorer composes every chunk the way the vertex shader does.
const chunkStream = cityPoses ? await (async () => {
  const count = city.topology.chunkCount;
  const radii = new Float32Array(count);
  const structures: Array<{ structureId: number; slotBase: number; chunks: number }> = [];
  for (const structure of manifestJson.structures) {
    const base = city.topology.slotOf(structure.structureId ?? structure.structure_id, 0);
    structures.push({ structureId: structure.structureId ?? structure.structure_id, slotBase: base, chunks: structure.chunks.length });
  }
  const store = new cityPoses.CityPoseStore(count, radii);
  store.trackChanges();
  const intactShift = perturb.chunk_intact ?? 0;
  const islandShift = perturb.chunk_island ?? 0;
  const shiftX = intactShift || islandShift
    ? (key: number) => ((key & 0x0f_ffff) === 0 ? intactShift : islandShift)
    : null;
  const writer = openChunkStream(join(outDir, 'drawn-chunks.bin'), {
    format: 'VLCHNK01',
    chunkCount: count,
    structures,
    simHz: header.simHz,
    clockOriginMs: originMs,
    stride: 'none (every body every frame)',
    tables: 'CityPoseStore after advanceCityPoses: body index -> (key, pose), slot -> (body index, local offset, local rotation)',
    perturb,
  }, shiftX);
  return { store, writer, state: null as null | { dirty: Set<number>; pendingRecords: Set<number>; lastLedgerEpoch: number }, radii, frames: 0 };
})() : null;

/** One frame of the city: the layer's pose step, then what changed in its tables. */
function drawCity(nowMs: number, simTick: number): void {
  if (!chunkStream || !cityPoses) {
    city.samplePresentation(nowMs);
    return;
  }
  const { store, radii } = chunkStream;
  if (!chunkStream.state) {
    // The layer builds its tables on its first frame with a client (buildCityMesh).
    cityPoses.initCityPoses(store, city, radii);
    chunkStream.state = cityPoses.newCityPoseFrameState(city);
  }
  cityPoses.advanceCityPoses(store, city, radii, chunkStream.state, nowMs, {});
  const clock = city.presentationClock();
  chunkStream.writer.frame(nowMs, simTick, clock.renderTick, clock.playoutDelayTicks, store, store.drainChanges());
  chunkStream.frames += 1;
}

// Data revisions of drawn bodies: each frame, a plain body drawn last frame is
// sampled again at the time it was drawn then, with what has arrived since.
// The distance to what was drawn is the part of this frame's step that new
// data caused -- the correction a viewer sees -- whatever the render time or
// lead did. A body drawn from samples it already had (interpolated) is never
// revised; one drawn past its newest sample is, when the next one disagrees.
// `sampleDynamicBodyDraw` is the client's draw at an explicit draw time
// (net/netcodeClient.ts); a client without it draws `sampleRemoteDynamicBody`
// at the render time.
const drawnBodies = new Map<number, { atUs: number; position: number[] }>();
const revisions = { compared: 0, over0_05: 0, over0_25: 0, over1: 0, over4: 0, metres: 0, max: 0 };
const sampleDraw = (id: number, atUs: number): { position: number[] } | null =>
  typeof client.sampleDynamicBodyDraw === 'function'
    ? client.sampleDynamicBodyDraw(id, atUs)
    : client.sampleRemoteDynamicBody(id, atUs);
const drawTimeUs = (id: number, renderUs: number): number =>
  typeof client.dynamicBodyDrawTimeUs === 'function' ? client.dynamicBodyDrawTimeUs(id, renderUs) : renderUs;

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
  // Remote players, as RemotePlayersRenderer draws them: the pose step is
  // netEntityPoses.ts `resolveRemotePlayerDraw`; a player in a vehicle (or
  // hidden) is not drawn, its vehicle is.
  for (const [id, latest] of client.remotePlayers) {
    const sample = client.sampleRemotePlayer(id, renderUs);
    if (entityPoses) {
      const draw = entityPoses.resolveRemotePlayerDraw(
        id, latest, sample, client.vehicles, (v: number, at: number) => client.sampleRemoteVehicle(v, at), renderUs,
      );
      if (!draw.visible) continue;
      entities.push({
        kind: KIND_PLAYER,
        flags: draw.sampled ? FLAG_SAMPLED : 0,
        id,
        position: draw.position,
        quaternion: [draw.yaw, sample?.pitch ?? latest.pitch, 0, 0],
        ageMs: Number.NaN,
      });
      continue;
    }
    entities.push({
      kind: KIND_PLAYER,
      flags: sample ? FLAG_SAMPLED : 0,
      id,
      position: sample?.position ?? latest.position,
      quaternion: [sample?.yaw ?? latest.yaw, sample?.pitch ?? latest.pitch, 0, 0],
      ageMs: Number.NaN,
    });
  }
  // Vehicles (GameWorld's pose callback: netEntityPoses.ts `remoteVehicleDrawPose`).
  // Flags: bit 0 sampled, bits 4-7 the vehicle type (identity).
  for (const [id, latest] of client.vehicles) {
    const sample = client.sampleRemoteVehicle(id, renderUs);
    const pose = entityPoses
      ? entityPoses.remoteVehicleDrawPose(latest, sample)
      : { position: sample?.position ?? latest.position, quaternion: sample?.quaternion ?? latest.quaternion, sampled: sample !== null };
    entities.push({
      kind: KIND_VEHICLE,
      flags: (pose.sampled ? FLAG_SAMPLED : 0) | (((latest.vehicleType ?? 0) & 0x0f) << 4),
      id,
      position: pose.position,
      quaternion: pose.quaternion,
      ageMs: client.getVehicleObservedAgeMs(id, localUs) ?? Number.NaN,
    });
  }
  // Dynamic bodies, as DynamicBodiesRenderer draws them: netEntityPoses.ts
  // `resolveDynamicBodyDraws` (meteor bodies skipped: the meteor layer draws
  // them), with MultiplayerGameRuntime's rendered state for a player who is
  // not touching the body: the interpolated state, else the latest.
  // Flags: bit 0 sampled, bits 4-7 the shape type (identity).
  const rendered = (id: number) => client.getInterpolatedDynamicBodyState(id);
  const bodyDraws: Array<{ id: number; body: { position: number[]; quaternion: number[]; shapeType: number } }> = entityPoses
    ? entityPoses.resolveDynamicBodyDraws(client.dynamicBodies, rendered)
    : [...client.dynamicBodies.keys()]
        .filter((id: number) => !meteorFlightsModule.isMeteorBody(id))
        .map((id: number) => ({ id, body: rendered(id) }))
        .filter((draw: { body: unknown }) => draw.body);
  const drawnNow = new Set<number>();
  for (const { id, body } of bodyDraws) {
    const sampled_ = client.sampleRemoteDynamicBody(id, dynRenderUs);
    const atUs = drawTimeUs(id, dynRenderUs);
    const before = drawnBodies.get(id);
    if (before) {
      const again = sampleDraw(id, before.atUs);
      if (again) {
        const d = Math.hypot(
          again.position[0] - before.position[0],
          again.position[1] - before.position[1],
          again.position[2] - before.position[2],
        );
        revisions.compared += 1;
        revisions.metres += d;
        revisions.max = Math.max(revisions.max, d);
        if (d > 0.05) revisions.over0_05 += 1;
        if (d > 0.25) revisions.over0_25 += 1;
        if (d > 1) revisions.over1 += 1;
        if (d > 4) revisions.over4 += 1;
      }
    }
    drawnBodies.set(id, { atUs, position: [...body.position] });
    drawnNow.add(id);
    entities.push({
      kind: KIND_BODY,
      flags: (sampled_ ? FLAG_SAMPLED : 0) | ((body.shapeType & 0x0f) << 4),
      id,
      position: body.position,
      quaternion: body.quaternion,
      ageMs: client.getDynamicBodyObservedAgeMs(id, localUs) ?? Number.NaN,
      leadUs: atUs - dynRenderUs,
    });
  }
  for (const id of drawnBodies.keys()) if (!drawnNow.has(id)) drawnBodies.delete(id);
  // Meteors, as MeteorLayer places them (meteorPlacement.ts `placeMeteorInFrame`).
  if (meteorPlacement) {
    const flights = meteorFlightsModule.meteorFlights(t, dynRenderUs);
    for (const flight of flights) {
      const placed = typeof meteorPlacement.placeMeteorInFrame === 'function'
        ? meteorPlacement.placeMeteorInFrame(flight, client, {
          renderServerUs: dynRenderUs,
          lagMs: client.dynamicBodyInterpolationDelayMs,
          nowMs: t,
          tickUs: TICK_US,
        })
        : meteorPlacement.placeMeteor(flight, flight.track, {
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
        leadUs: placed.leadUs ?? 0,
      });
    }
  }
  drawCity(t, simTickAt(t));
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
    entities: entities.map(shift),
  }, true));
  writePresented(t);
  sampled += 1;
}
await new Promise<void>((done, fail) => {
  displayFile.end(() => done());
  displayFile.on('error', fail);
});
await presentedStream.end();
if (chunkStream) await chunkStream.writer.end();

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
  sharedPoses: { entities: entityPoses !== null, city: cityPoses !== null },
  chunkFrames: chunkStream?.frames ?? 0,
  clientCpuMs: +clientMs.toFixed(1),
  // Snapshots applied as the newest, and those that arrived after a newer
  // one (dropped whole by clients before the late-snapshot change, applied
  // per entity since).
  snapshots: snapshotCounts(),
  bodyRevisions: revisions,
  bodyLead: typeof client.dynamicBodyLeadStats === 'function' ? client.dynamicBodyLeadStats() : null,
  city: city.stats(),
};
function snapshotCounts(): { newest: number; late: number } | null {
  const telemetry = (client as { getDebugTelemetrySnapshot?: () => Record<string, number> }).getDebugTelemetrySnapshot?.();
  if (!telemetry) return null;
  const newest = ['datagramSnapshotsReceived', 'reliableSnapshotsReceived', 'localSnapshotsReceived', 'directSnapshotsReceived']
    .reduce((sum, key) => sum + (telemetry[key] ?? 0), 0);
  return { newest, late: telemetry.staleSnapshotsDropped ?? 0 };
}
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
