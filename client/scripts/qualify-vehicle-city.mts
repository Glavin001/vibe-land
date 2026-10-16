/**
 * The vehicle netcode replay on a recorded /city drive. CPU-only, fixed-tick:
 * no browser, server or GPU.
 *
 * A tape from e2e/vehicle-measure.mjs holds, per server tick, the input the
 * server applied to the driven car and the car's state after the step. It is
 * replayed through the shipping driver predictor and observer interpolator
 * (netlab/vehicle/replay.ts) under every receive schedule and seed, and
 * scored by the qualification evaluator (netlab/vehicle/evaluate.ts, limits
 * in contracts.ts) - exactly as scripts/qualify-vehicle-netcode.mts does the
 * pinned garage tape. What differs is the world the predictor sweeps:
 *
 *   --world flat   the /city client world as it was: flat ground only.
 *   --world city   that ground plus every chunk of the intact city as its own
 *                  shape (vehicles/cityColliders.ts, as the client loads it).
 *
 * The same tape under both worlds isolates what the colliders change. The
 * replay applies inputs as the server applied them, so it measures the
 * prediction and its collisions, not the input pipeline (the live run's
 * report counts that).
 *
 *   npx tsx scripts/qualify-vehicle-city.mts --tape <tape.json> --world city \
 *     [--server http://127.0.0.1:6921] [--seeds 7,42,1337] [--out dir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import init, { WasmSimWorld } from '../src/wasm/pkg/vibe_land_shared.js';
import { vehicleProxy, type Sweep } from '../src/physics/vehiclePresentation';
import { LINK_CASES } from '../netlab/vehicle/schedule';
import { VEHICLE_QUALITY_SCENARIOS } from '../netlab/vehicle/scenarios';
import { evaluateVehicleQuality } from '../netlab/vehicle/evaluate';
import { replayVehicleTrace, type NativeTrace } from '../netlab/vehicle/replay';
import { QUALITY_VERSION, LIMITS } from '../netlab/vehicle/contracts';
import { CITY_WORLD_DOCUMENT } from '../src/world/cityWorld';
import { decodeBinaryManifest } from '../src/city/manifestBinary';
import { resolveShapeLibrary } from '../src/city/manifest';
import { intactCityShapes } from '../src/vehicles/cityColliders';

const args = process.argv.slice(2);
const option = (key: string, fallback?: string) => {
  const at = args.indexOf(key);
  if (at < 0) {
    if (fallback === undefined) throw Error(`Missing ${key}`);
    return fallback;
  }
  return args[at + 1];
};
const tapePath = option('--tape');
const world = option('--world', 'city');
if (!['flat', 'city'].includes(world)) throw Error('--world flat|city');
const server = option('--server', 'http://127.0.0.1:6921');
// Or the city's chunks from its scene file (structures/<pack>/out/<pack>.json):
// world-space centroids, cuboids and the hull library, no server needed.
const scenePath = option('--scene', '');
const seeds = option('--seeds', '7,42,1337').split(',').map(Number);
const out = resolve(option('--out', `${tapePath.replace(/\.json$/, '')}-replay-${world}`));
mkdirSync(out, { recursive: true });

// The drive: the longest run of consecutive ticks, on the replay's 60 Hz clock.
const tape = JSON.parse(readFileSync(tapePath, 'utf8')) as { vehicle: unknown; frames: { tick: number; input: NativeTrace['frames'][0]['input']; sample: NativeTrace['frames'][0]['sample']; released?: [number, number][] }[] };
let best: typeof tape.frames = [], run: typeof tape.frames = [];
for (const f of tape.frames) {
  run = run.length && f.tick === run[run.length - 1].tick + 1 ? [...run, f] : [f];
  if (run.length > best.length) best = run;
}
const trace: NativeTrace = {
  world: null,
  // Each tick's applied input as its own input: the server repeats the last
  // one when its queue runs dry and collapses a backlog, which the live
  // report counts; here the pipeline is perfect.
  frames: best.map((f, i) => ({ input: { ...f.input, seq: (i + 1) & 0xffff }, sample: { ...f.sample, serverTimeUs: i * 1e6 / 60 } })),
};

await init({ module_or_path: readFileSync(new URL('../src/wasm/pkg/vibe_land_shared_bg.wasm', import.meta.url)) });
const sim = new WasmSimWorld();
sim.loadWorldDocument(JSON.stringify(CITY_WORLD_DOCUMENT));
sim.rebuildBroadPhase();
let shapes = 0;
// Every shape as loaded, to put dropped ones back between runs.
let all: { keys: Uint32Array; poses: Float32Array; counts: Uint32Array; data: Float32Array } | null = null;
// A city chunk's collider key from (structure, node), once the world is built.
let keyOf: (structure: number, node: number) => number | undefined = () => undefined;
// Every sweep the predictor makes that a city chunk stopped sideways (the
// car blocked, not supported): where, by which probe, and what was there.
const blocks: { at: number[]; wheel: boolean; normalY: number }[] = [];
let sceneNodes: { centroid: { x: number; y: number; z: number } }[] = [];
let sceneTypes: string[] = [];
if (world === 'city' && scenePath) {
  const scene = JSON.parse(readFileSync(scenePath, 'utf8')).scenario as {
    nodes: { centroid: { x: number; y: number; z: number } }[];
    nodeColliders: ({ kind: 'cuboid'; halfExtents: { x: number; y: number; z: number } } | { kind: 'shape'; shape: number })[];
    shapeLibrary: { points: number[] }[];
    nodeTypes: string[];
  };
  sceneNodes = scene.nodes;
  // A scene is one structure: its nodes are the keys.
  keyOf = (_structure, node) => node;
  sceneTypes = scene.nodeTypes;
  const keys = new Uint32Array(scene.nodes.length), poses = new Float32Array(scene.nodes.length * 7), counts = new Uint32Array(scene.nodes.length);
  const data: number[] = [];
  scene.nodes.forEach((n, i) => {
    keys[i] = i;
    poses.set([n.centroid.x, n.centroid.y, n.centroid.z, 0, 0, 0, 1], i * 7);
    const c = scene.nodeColliders[i];
    if (c.kind === 'shape') {
      const points = scene.shapeLibrary[c.shape].points;
      counts[i] = points.length / 3;
      data.push(...points);
    } else {
      data.push(c.halfExtents.x, c.halfExtents.y, c.halfExtents.z);
    }
  });
  all = { keys, poses, counts, data: Float32Array.from(data) };
  shapes = sim.setStaticShapes(all.keys, all.poses, all.counts, all.data);
} else if (world === 'city') {
  const config = await (await fetch(`${server}/session-config?match_id=city-default`)).json() as { city_manifest_hash: string };
  const bytes = Buffer.from(await (await fetch(`${server}/city-manifest/${config.city_manifest_hash}`)).arrayBuffer());
  const raw = bytes[0] === 0x1f ? gunzipSync(bytes) : bytes;
  const manifest = decodeBinaryManifest(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  resolveShapeLibrary(manifest);
  const packed = intactCityShapes(manifest);
  const base = new Map<number, number>();
  let offset = 0;
  for (const s of manifest.structures) { base.set(s.structureId, offset); offset += s.chunks.length; }
  keyOf = (structure, node) => { const b = base.get(structure); return b === undefined ? undefined : b + node; };
  all = packed;
  shapes = sim.setStaticShapes(packed.keys, packed.poses, packed.counts, packed.data);
}
const sweep: Sweep = (p, q, d, h, r = 0) => {
  const hit = sim.sweepVehicleStatic(...([...p, ...q, ...d, ...h, r] as [number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
  if (hit.length && hit[2] <= 0.45 && world === 'city') blocks.push({ at: p.map((v, k) => v + d[k] * hit[0]), wheel: r > 0, normalY: hit[2] });
  return hit.length ? { fraction: hit[0], normal: [hit[1], hit[2], hit[3]] } : null;
};
// Chunk keys released at each trace index (`released` in the tape), and the
// world's shapes kept to put back between runs.
const released: number[][] = best.map((f) => (f.released ?? []).map(([s, n]) => keyOf(s, n)).filter((k): k is number => k !== undefined));
const releasedCount = released.reduce((n, r) => n + r.length, 0);
const removedKeys = new Set<number>();
const restore = (keys: Uint32Array) => {
  if (!all) return;
  const want = new Set(keys);
  const k: number[] = [], p: number[] = [], c: number[] = [], d: number[] = [];
  let at = 0;
  all.keys.forEach((key, i) => {
    const take = all!.counts[i] === 0 ? 3 : all!.counts[i] * 3;
    if (want.has(key)) {
      k.push(key);
      p.push(...all!.poses.subarray(i * 7, i * 7 + 7));
      c.push(all!.counts[i]);
      d.push(...all!.data.subarray(at, at + take));
    }
    at += take;
  });
  sim.setStaticShapes(Uint32Array.from(k), Float32Array.from(p), Uint32Array.from(c), Float32Array.from(d));
};
const proxy = vehicleProxy({ ...trace.frames[0].sample, id: 7, driverId: 10, vehicleType: 0, customVehicle: tape.vehicle as never } as never);
const contract = VEHICLE_QUALITY_SCENARIOS.find((s) => s.id === 'recorded-course')!;
const pick = (m: { id: string; value: number }[], id: string) => m.find((x) => x.id === id)?.value;
const cases: unknown[] = [];
const summary: Record<string, string[]> = {};
for (const link of LINK_CASES) {
  for (const seed of seeds) {
    if (link.blackout && link.blackout[1] >= trace.frames.length) continue;
    // Each run starts from the intact city, and drops a chunk once a
    // snapshot from its release tick (or later) reaches the client: the
    // client's colliders follow the fractures it has heard of.
    if (world === 'city') {
      const keys = Uint32Array.from(removedKeys);
      if (keys.length) restore(keys);
      removedKeys.clear();
    }
    let releasedThrough = -1;
    const onArrive = released.length ? (sourceTick: number) => {
      if (sourceTick <= releasedThrough) return;
      const drop: number[] = [];
      for (let t = releasedThrough + 1; t <= sourceTick; t++) for (const k of released[t] ?? []) if (!removedKeys.has(k)) { removedKeys.add(k); drop.push(k); }
      releasedThrough = sourceTick;
      if (drop.length) sim.removeStaticShapes(Uint32Array.from(drop));
    } : undefined;
    const evidence = replayVehicleTrace(trace, proxy, sweep, link, seed, 0, onArrive);
    const scores = [evaluateVehicleQuality(evidence.driver, contract), evaluateVehicleQuality(evidence.observer, contract)];
    cases.push({ link: link.id, seed, scores });
    const d = scores[0];
    const f = (id: string) => pick(d.metrics, id)?.toFixed(3);
    (summary[link.id] ??= []).push(`p95 ${f('position-p95')} 1s ${f('worst-second-position-p95')} max ${f('position-max')} step ${f('visual-error-step-max')} corr ${f('correction-max')} hard/min ${pick(d.metrics, 'hard-corrections-per-minute')?.toFixed(1)}`);
  }
}
sim.free();
if (blocks.length && sceneNodes.length) {
  // The chunk nearest each block, by kind.
  const kinds = new Map<string, number>();
  for (const b of blocks.slice(0, 20000)) {
    let best = -1, bestD = Infinity;
    sceneNodes.forEach((n, i) => {
      const dd = (n.centroid.x - b.at[0]) ** 2 + (n.centroid.y - b.at[1]) ** 2 + (n.centroid.z - b.at[2]) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    });
    const k = `${b.wheel ? 'wheel' : 'chassis'} vs ${sceneTypes[best]} (y ${sceneNodes[best].centroid.y.toFixed(2)})`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  console.log(`sideways blocks: ${blocks.length}`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}  ${k}`);
}
const report = { version: QUALITY_VERSION, scope: `recorded /city drive (${tapePath}), driver and observer presentation, world ${world}`,
  world, shapes, ticks: trace.frames.length, proxy, limits: LIMITS, seeds, cases };
writeFileSync(resolve(out, 'quality.json'), JSON.stringify(report, null, 1));
console.log(`world ${world}: ${shapes} chunk shapes, ${releasedCount} released during the drive; ${trace.frames.length} ticks`);
for (const [link, rows] of Object.entries(summary)) console.log(`${link.padEnd(20)} driver: ${rows.join(' | ')}`);
