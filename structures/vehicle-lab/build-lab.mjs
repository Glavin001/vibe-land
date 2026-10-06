#!/usr/bin/env node
// The vehicle test bed's scene (scripts/native-mac.sh vehicle-lab, and the
// headless GPU oracle server/src/vehicle_testbed.rs): parallel lanes, each
// one obstacle a car is driven at, and open pads for the handbrake turn, the
// cannonball and the meteor.
//
//   node structures/vehicle-lab/build-lab.mjs
//   -> structures/vehicle-lab/out/vehicle-lab.json   (ScenePack v2)
//      structures/vehicle-lab/out/vehicle-lab.meta.json (lanes, trials, criteria)
//      structures/vehicle-lab/out/vehicle-lab.slots  (one parking spot per trial)
//
// x east, z north. Every lane runs north (+z, heading 0) from its start at
// z = START_Z. Lanes are 16 m apart; nothing a car does in one reaches the
// next. What each lane holds, and why, is in trials.mjs (LANES); the scene
// is built from that table, so the harnesses and the scene cannot disagree.
//
// Ground: the city's own flat ground at y = 0 (server demo_world city_world),
// paved where a lane says so the way Vibe Town paves its streets (thin
// destructible surfacing on a fixed buried subgrade, build-town.mjs): the
// wheels must stand on chunk surfaces, as they do in the town. Curbs, steps
// and ramps are static (fixed, mass 0). Debris and the rubble pile are loose
// chunks: one node each, no bonds, so each is its own body from the start,
// sized from Vibe Town's own chunks (trials.mjs DEBRIS). The wall is masonry
// blocks on a fixed footing; the house is the qualified one-storey skyline
// house Elm Park is built from.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeScene, Builder } from '../town-kit/src/geometry.mjs';
import { M, mortarJoints } from '../town-kit/src/materials.mjs';
import { buildVeneerBungalow } from '../town-kit/src/veneer-houses.mjs';
import { LANES, PADS, START_Z, LANE_LENGTH, DEBRIS, TRIALS, slotOf } from './trials.mjs';
import { CONE, turningCones } from './turning.mjs';
import { assertStrikesClear } from '../../client/native/film/shots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const KEY = 'vehicle-lab';
const HALF_LANE = 4;

/** Deterministic pseudo-random numbers for debris placement. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Static ground features and paving: one builder, fixed except the paving. */
function buildGround() {
  const b = new Builder('vehicle-lab-ground', { group: 'terrain' });
  const asphalt = b.table.push({ ...b.table[M.footing], name: 'asphalt-subgrade', color: '#4f5655', textureKey: null, roughness: 1 }) - 1;
  const kerb = b.table.push({ ...b.table[M.footing], name: 'kerb-stone', color: '#b8b2a2', textureKey: 'concrete-wall', roughness: 1 }) - 1;
  const ramp = b.table.push({ ...b.table[M.footing], name: 'ramp-concrete', color: '#9c968a', textureKey: 'concrete-wall', roughness: 1 }) - 1;
  for (const lane of LANES) {
    const x0 = lane.x - HALF_LANE, x1 = lane.x + HALF_LANE;
    const z0 = START_Z - 10, z1 = START_Z + (lane.length ?? LANE_LENGTH);
    if (lane.paved && lane.paveTo != null) {
      b.box({ min: [x0, -0.16, z0], max: [x1, 0, lane.paveTo], material: M.footing, fixed: true, type: 'foundation' });
      b.box({ min: [x0, 0, z0], max: [x1, 0.025, lane.paveTo], material: asphalt, type: 'road', split: [2, 1, Math.round((lane.paveTo - z0) / 4)] });
    } else if (lane.paved) {
      // Vibe Town's street: 2.5 cm of asphalt in ~4 m pieces on a fixed subgrade.
      b.box({ min: [x0, -0.16, z0], max: [x1, 0, z1], material: M.footing, fixed: true, type: 'foundation' });
      b.box({ min: [x0, 0, z0], max: [x1, 0.025, z1], material: asphalt, type: 'road', split: [2, 1, Math.round((z1 - z0) / 4)] });
    }
    const o = lane.obstacle;
    if (o.kind === 'step') {
      // Up `height` onto a deck `deck` metres long, then down again.
      b.box({ min: [x0, 0, o.z], max: [x1, o.height, o.z + o.deck], material: kerb, fixed: true, type: 'kerb' });
    } else if (o.kind === 'ramp') {
      // Up at `angle` to `height`, a deck, and down at the same angle.
      const run = o.height / Math.tan((o.angle * Math.PI) / 180);
      const zTop = o.z + run, zEnd = zTop + o.deck;
      b.piece({ axis: 'x', poly: [[0, o.z], [0, zTop], [o.height, zTop]], lo: x0, hi: x1, material: ramp, fixed: true, type: 'ramp' });
      b.box({ min: [x0, 0, zTop], max: [x1, o.height, zEnd], material: ramp, fixed: true, type: 'ramp-deck' });
      b.piece({ axis: 'x', poly: [[0, zEnd], [o.height, zEnd], [0, zEnd + run]], lo: x0, hi: x1, material: ramp, fixed: true, type: 'ramp' });
    }
  }
  return { pack: b.build() };
}

/** Loose chunks: one node each, spaced so no two touch (no bonds). */
function buildLoose() {
  const b = new Builder('vehicle-lab-debris', { group: 'debris' });
  const concrete = M.footing; // 2400 kg/m^3, the town's slabs and footings
  const brick = M.brick;       // 1900 kg/m^3, the town's walls
  const placed = [];
  const fits = (x, z, r, y0, y1) => placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r + 0.03 || y0 > p.y1 + 0.004 || y1 < p.y0 - 0.004);
  const put = (x, z, yaw, [hx, hy, hz], y0, material) => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const corner = (u, w) => [x + u * c - w * s, z + u * s + w * c];
    const poly = [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)];
    b.piece({ axis: 'y', poly, lo: y0, hi: y0 + 2 * hy, material, type: 'rubble' });
    placed.push({ x, z, r: Math.hypot(hx, hz), y0, y1: y0 + 2 * hy });
  };
  for (const lane of LANES) {
    const o = lane.obstacle;
    const base = lane.paved ? 0.026 : 0.001;
    if (o.kind === 'debris') {
      // A field of loose pieces across the lane, every size of DEBRIS.
      const random = rng(o.seed);
      let n = 0;
      for (let tries = 0; n < o.count && tries < 5000; tries += 1) {
        const size = DEBRIS[n % DEBRIS.length];
        const [hx, , hz] = size.half;
        const x = lane.x + (random() * 2 - 1) * (HALF_LANE - 0.6), z = o.z + random() * o.length, yaw = random() * Math.PI;
        if (!fits(x, z, Math.hypot(hx, hz), base, base + 2 * size.half[1])) continue;
        put(x, z, yaw, size.half, base, size.material === 'brick' ? brick : concrete);
        n += 1;
      }
      if (n < o.count) throw new Error(`${lane.id}: placed ${n} of ${o.count} pieces`);
    } else if (o.kind === 'pile') {
      // A heap: layers of the larger pieces, each layer narrower, to `height`.
      const random = rng(o.seed);
      let y = base, layer = 0;
      while (y < base + o.height - 0.05) {
        const size = DEBRIS[DEBRIS.length - 1 - (layer % 2)];
        const [hx, hy, hz] = size.half;
        const radius = o.radius * (1 - (y - base) / (o.height + 0.3));
        let n = 0;
        for (let tries = 0; tries < 400; tries += 1) {
          const a = random() * 2 * Math.PI, d = Math.sqrt(random()) * radius;
          const x = lane.x + Math.cos(a) * d * 0.9, z = o.z + Math.sin(a) * d, yaw = random() * Math.PI;
          if (Math.abs(x - lane.x) + Math.hypot(hx, hz) > HALF_LANE + 0.5) continue;
          if (!fits(x, z, Math.hypot(hx, hz), y, y + 2 * hy)) continue;
          put(x, z, yaw, size.half, y, size.material === 'brick' ? brick : concrete);
          n += 1;
        }
        if (!n) break;
        y += 2 * hy + 0.005;
        layer += 1;
      }
    }
  }
  // The turning ground's cones (turning.mjs): light loose posts, knocked over
  // by a truck that touches one.
  const cone = b.table.push({ ...b.table[M.frame], name: 'traffic-cone', color: CONE.color, textureKey: CONE.textureKey, density: CONE.density }) - 1;
  for (const c of turningCones()) put(c.x, c.z, 0, CONE.half, 0.001, cone);
  return { pack: b.build() };
}

/** The masonry wall: blocks bonded to each other and to a fixed footing. */
function buildWall(o) {
  const b = new Builder('vehicle-lab-wall', { group: 'wall@brick-wall' });
  const w = o.width / 2, t = o.thickness / 2;
  b.box({ min: [-w - 0.2, -0.5, -t - 0.15], max: [w + 0.2, 0, t + 0.15], material: M.footing, fixed: true, type: 'foundation' });
  b.box({ min: [-w, 0, -t], max: [w, o.height, t], material: M.brick, type: 'wall',
    split: [Math.round(o.width / o.block[0]), Math.round(o.height / o.block[1]), 1] });
  return { pack: b.build() };
}

function skyline(file) {
  const pack = JSON.parse(readFileSync(path.join(repo, 'destruction/assets/scenes', file), 'utf8'));
  const s = pack.scenario, n = s.nodes.length;
  s.nodeGroups ??= Array(n).fill('building');
  s.nodePieces ??= s.nodes.map((_, i) => i);
  s.nodeMaterials ??= s.nodes.map((node) => pack.defaults.solver.materials[node.m ?? 0].name);
  mortarJoints(pack);
  return { pack };
}

export function buildLab() {
  const placements = [
    { ...buildGround(), position: [0, 0, 0], yaw: 0, group: 'terrain' },
    { ...buildLoose(), position: [0, 0, 0], yaw: 0 },
  ];
  for (const lane of LANES) {
    const o = lane.obstacle;
    if (o.kind === 'wall') placements.push({ ...buildWall(o), position: [lane.x, 0, o.z], yaw: 0, group: `wall@${lane.id}` });
    if (o.kind === 'house') placements.push({ ...skyline('house-1story.json'), position: [lane.x, 0, o.z], yaw: 0, group: `house@${lane.id}` });
    if (o.kind === 'framed-house') placements.push({ pack: buildVeneerBungalow().pack, position: [lane.x, 0, o.z], yaw: 0, group: `framed-house@${lane.id}` });
    if (o.kind === 'street') {
      o.strikes = [];
      for (const [k, { side, file }] of o.houses.entries()) {
        const asset = skyline(file), s = asset.pack.scenario;
        const extent = (axis, sign) => Math.max(...s.nodes.map((n, i) => sign * n.centroid[axis] + s.nodeSizes[i][axis] / 2));
        const top = extent('y', 1), half = extent('x', side > 0 ? -1 : 1);
        // Its street-facing wall `setback` from the lane's centre.
        const x = lane.x + side * (o.setback + half);
        placements.push({ ...asset, position: [x, 0, o.z], yaw: 0, group: `house@${lane.id}-${k}` });
        // As chase-shots.mjs aims: half way up, 1.5 m into the wall, from
        // across the street -- and 3 m along it, either way by side: aimed
        // square across from each other, the two met over the road.
        o.strikes.push({ target: [lane.x + side * (o.setback + 1.5), +(top * 0.5).toFixed(2), o.z + side * 3], from: side > 0 ? 270 : 90 });
      }
    }
  }
  // Strikes launched together must not meet in flight (both harnesses launch
  // a lane's strikes at once, with the trial's flight and slope).
  for (const trial of TRIALS.filter((t) => t.attack?.kind === 'strikes')) {
    const lane = LANES.find((l) => `lane/${l.id}` === trial.at);
    assertStrikesClear(lane.obstacle.strikes.map((s) => ({ ...s, flight: trial.attack.flight, slope: trial.attack.slope })), `trial ${trial.id}`);
  }
  const pack = composeScene(placements, { key: KEY, title: 'Vehicle test bed' });
  const nodes = pack.scenario.nodes;
  const loose = nodes.filter((n, i) => n.mass > 0 && pack.scenario.nodeGroups[i] === 'debris');
  // Named places for the native harness and films: each lane's start, its
  // obstacle, each pad.
  const places = [
    ...LANES.map((lane) => ({ id: `lane/${lane.id}`, kind: 'lane', name: lane.name, position: [lane.x, 0, START_Z], obstacle: [lane.x, 0, lane.obstacle.z ?? 0] })),
    ...PADS.map((pad) => ({ id: `pad/${pad.id}`, kind: 'pad', name: pad.name, position: [pad.x, 0, pad.z] })),
  ];
  const trials = TRIALS.map((trial, index) => ({ ...trial, index, slot: slotOf(trial) }));
  return { pack, places, trials, loose };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pack, places, trials, loose } = buildLab();
  const out = path.join(here, 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${KEY}.json`), JSON.stringify(pack));
  writeFileSync(path.join(out, `${KEY}.meta.json`), JSON.stringify({ lanes: LANES, pads: PADS, startZ: START_Z, debris: DEBRIS, trials, places }, null, 1));
  writeFileSync(path.join(out, `${KEY}.slots`), trials.map((t) => t.slot.join(',')).join(';'));
  const masses = loose.map((n) => n.mass).sort((a, b) => a - b);
  console.log(`${KEY}: ${pack.scenario.nodes.length} nodes, ${pack.scenario.bonds.length} bonds; ${loose.length} loose pieces ${masses[0]?.toFixed(0)}-${masses.at(-1)?.toFixed(0)} kg; ${trials.length} trials`);
}
