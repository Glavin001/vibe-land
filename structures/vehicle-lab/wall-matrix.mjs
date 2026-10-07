#!/usr/bin/env node
// The wall matrix: every way an impactor can meet an "effectively infinite
// wall" in the vehicle lab -- impactor x target x angle x hit point -- as
// test-bed trials (server/src/vehicle_testbed.rs, probed by wall_matrix.rs).
//
//   node structures/vehicle-lab/wall-matrix.mjs [--pack PACK] [--set core|angles|points|targets|truck|all] [--scene town] [--out FILE]
//   -> structures/vehicle-lab/out/wall-matrix.meta.json (the lab meta, its trials replaced)
//   scripts/wall-matrix.sh runtime|high [--set ...]  builds, runs and judges it
//
// Each target is a named point on a lab structure's face (checked against the
// pack: the chunk nearest it is reported), the compass bearing its outward
// normal faces (`face`: a shot from there is square on), the axes along the
// face for a seam (`along`) and a joint (`up`), and the depth of the layer an
// impactor must get through (`layer`, m). x east, z north; bearing 0 = +z.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Lab targets (structures/vehicle-lab/trials.mjs LANES; coordinates from the pack). */
export const TARGETS = [
  // The brick-veneer bungalow (lane framed-house, x 124): brick skin 20.05-20.14,
  // stud frame behind it to 20.34, drywall at 20.34. Studs at x 122.20,
  // 122.76, 123.36, 123.96, 124.56, 125.16. Brick-veneer chunks 0.6 x 0.41 m.
  { id: 'veneer', name: 'veneer skin between studs', group: 'framed-house', aim: [123.5, 1.16, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-stud', name: 'veneer over a stud', group: 'framed-house', aim: [122.76, 1.16, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-corner', name: 'front-left corner', group: 'framed-house', aim: [119.1, 1.16, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-window', name: 'front window (glazing)', group: 'framed-house', aim: [120.9, 1.56, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-door', name: 'beside the front door frame', group: 'framed-house', aim: [125.62, 1.14, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-base', name: 'bottom course, over the footing', group: 'framed-house', aim: [123.5, 0.2, 20.095], face: 180, along: 'x', layer: 0.3 },
  { id: 'veneer-side', name: 'east side wall', group: 'framed-house', aim: [129.05, 1.16, 24.09], face: 90, along: 'z', layer: 0.3 },
  { id: 'veneer-roof', name: 'roof tiles, from above', group: 'framed-house', aim: [124.0, 3.63, 24.0], face: 180, along: 'x', layer: 0.5, slope: 1.0 },
  // The masonry wall (lane wall, x 32): 14 x 5 blocks of 0.5 m, 0.25 m thick,
  // on a fixed footing; south face z 19.875.
  { id: 'masonry', name: 'masonry wall, block centre', group: 'wall', aim: [32.25, 1.25, 19.875], face: 180, along: 'x', layer: 0.25 },
  { id: 'masonry-base', name: 'masonry wall, bottom row over the footing', group: 'wall', aim: [32.25, 0.25, 19.875], face: 180, along: 'x', layer: 0.25 },
  { id: 'masonry-end', name: 'masonry wall, free end', group: 'wall', aim: [28.75, 1.25, 19.875], face: 180, along: 'x', layer: 0.25 },
  // The skyline one-storey (lane house, x 56): brick 0.25 m, front face 20.005.
  { id: 'brick-house', name: 'one-storey brick house wall', group: 'house@house', aim: [53.57, 0.86, 20.005], face: 180, along: 'x', layer: 0.25 },
  { id: 'brick-house-corner', name: 'one-storey brick house corner', group: 'house@house', aim: [51.3, 0.95, 20.005], face: 180, along: 'x', layer: 0.25 },
  // The two-storey across North Street (lane street, house@street-1): stone
  // 0.3 m, street face x 98.85, facing west.
  { id: 'stone-house', name: 'two-storey stone house wall', group: 'house@street-1', aim: [98.85, 1.31, 2.01], face: 270, along: 'z', layer: 0.3 },
  // The rubble pile (lane rubble, x 16): loose pieces, nothing anchored.
  { id: 'pile', name: 'rubble pile', group: 'debris', aim: [16, 0.5, 4.0], face: 180, along: 'x', layer: 3 },
];

/** Impactors: the game's two weapons, a light ball, and the monster truck. */
export const IMPACTORS = {
  cannonball: { attack: 'cannonball' },            // 10.65 t steel at 60 m/s (city.rs)
  meteor: { attack: 'meteor' },                    // 110 t rock, r 2 m, 140 m/s (meteor.rs)
  ball100: { attack: 'cannonball', mass: 100 },    // 100 kg steel (r 0.146 m) at 60 m/s: the impact study's
  ball1000: { attack: 'cannonball', mass: 1000 },  // 1 t steel (r 0.31 m) at 60 m/s
  truck10: { truck: 10 }, truck20: { truck: 20 },  // the monster truck (5 t) at 10 and 20 m/s
};

const ANGLES = { 0: 0, 30: 30, 60: 60, glancing: 78 };

/** A point on the target's face: centre, a seam (half a chunk along), a joint (and half up). */
function hitPoint(target, point, node) {
  const aim = [...target.aim];
  if (point === 'centre' || !node) return aim;
  const k = target.along === 'x' ? 0 : 2;
  const half = node.size[target.along] / 2;
  aim[k] = node.centroid[target.along] + half;
  if (point === 'joint') aim[1] = node.centroid.y + node.size.y / 2;
  return aim.map((v) => +v.toFixed(3));
}

function nearestNode(pack, target) {
  const s = pack.scenario;
  let best = null;
  for (let i = 0; i < s.nodes.length; i += 1) {
    if (!s.nodeGroups[i].startsWith(target.group) || !(s.nodes[i].mass > 0)) continue;
    const c = s.nodes[i].centroid;
    const d = Math.hypot(c.x - target.aim[0], c.y - target.aim[1], c.z - target.aim[2]);
    if (!best || d < best.d) best = { d, i, centroid: c, size: s.nodeSizes[i], type: s.nodeTypes[i], material: s.nodeMaterials[i], mass: s.nodes[i].mass };
  }
  return best;
}

/** One trial: `impactor` at `target`'s `point`, `angle` degrees off square. */
function trial(pack, target, impactorId, angle, point = 'centre', extra = {}) {
  const imp = IMPACTORS[impactorId];
  const node = nearestNode(pack, target);
  const aim = hitPoint(target, point, node);
  const from = (target.face + ANGLES[angle]) % 360;
  const id = `wm-${target.id}-${impactorId}-${angle}${point === 'centre' ? '' : `-${point}`}${extra.suffix ?? ''}`;
  const base = { id, probe: true, target: aim, layer: target.layer, matrix: { target: target.id, group: target.group, impactor: impactorId, angle, point, chunk: node && { index: node.i, type: node.type, material: node.material, mass: node.mass } } };
  if (imp.truck) {
    // Start far enough back to reach the speed, square on to the bearing.
    const speed = imp.truck, run = speed > 15 ? 55 : 30;
    const b = (from * Math.PI) / 180;
    const heading = (from + 180) % 360;
    const start = [aim[0] + Math.sin(b) * run, aim[2] + Math.cos(b) * run];
    return { ...base, at: `slot/${start[0].toFixed(2)},${start[1].toFixed(2)},${heading}`, drive: { kind: 'cruise', speed }, seconds: run / speed + 3.5 };
  }
  const attack = { kind: 'shot', projectile: imp.attack === 'meteor' ? 'meteor' : 'cannonball', at: 0.5, target: aim, from,
    slope: target.slope ?? (target.town ? (imp.attack === 'meteor' ? 0.5 : 0.1) : imp.attack === 'meteor' ? 0.05 : 0.02),
    distance: target.town ? (imp.attack === 'meteor' ? 40 : 12) : imp.attack === 'meteor' ? 70 : 30, ...(imp.mass ? { mass: imp.mass } : {}) };
  if (extra.repeat) {
    // A previously damaged wall: the same shot twice, a second apart; the probe reads the second.
    return { ...base, at: 'pad/rest', slot: [110, -120, 0], drive: { kind: 'park' }, seconds: 3.5,
      attack: { kind: 'shots', at: 0.5, from, slope: attack.slope, distance: attack.distance, mass: imp.mass ?? 10650, shots: [{ t: 0.5, target: aim, mass: imp.mass ?? 10650 }, { t: 1.5, target: aim, mass: imp.mass ?? 10650 }] } };
  }
  return { ...base, at: 'pad/rest', slot: [110, -120, 0], drive: { kind: 'park' }, seconds: 2.5, attack };
}

/**
 * Vibe Town targets (--scene town): South Street's south pavement (z about
 * -55; the road's centre z -48, its north houses from z -38) -- each kind of
 * prop and tree, and the street wall of a one-storey house, found in the pack
 * (the instance of the kind nearest `near`), shot from the street (face 0,
 * from the north) at its middle. The truck comes 40 m down the road's centre
 * and swerves into it (face 80).
 */
export const TOWN = [
  { id: 'mailbox', kind: 'mailbox', near: [-129.5, 1, -55], y: 1.0 },
  { id: 'streetlight', kind: 'streetlight', near: [-49, 1, -55], y: 1.2 },
  { id: 'tree', kind: 'tree', near: [-71, 1, -56], y: 1.2, types: ['trunk'] },
  { id: 'hydrant', kind: 'hydrant', near: [6.9, 0.4, -55], y: 0.4 },
  { id: 'street-sign', kind: 'street-sign', near: [-86.9, 1.7, -41], y: 1.2 },
  { id: 'bench', kind: 'bench', near: [13, 0.5, -14], y: 0.5 },
  { id: 'bus-shelter', kind: 'bus-shelter', near: [12, 1.7, -8.5], y: 1.5 },
  { id: 'town-house', kind: 'house', near: [-68, 1.2, -58.3], y: 1.2, layer: 0.3 },
];

function townTarget(pack, t) {
  const s = pack.scenario;
  let best = null;
  for (let i = 0; i < s.nodes.length; i += 1) {
    if (s.nodeGroups[i].split('@')[0] !== t.kind || !(s.nodes[i].mass > 0)) continue;
    if (t.types && !t.types.includes(s.nodeTypes[i])) continue;
    const c = s.nodes[i].centroid, d = Math.hypot(c.x - t.near[0], c.y - t.near[1], c.z - t.near[2]);
    if (!best || d < best.d) best = { d, group: s.nodeGroups[i] };
  }
  const nodes = s.nodes.map((n, i) => i).filter((i) => s.nodeGroups[i] === best.group && s.nodes[i].mass > 0 && (!t.types || t.types.includes(s.nodeTypes[i])));
  const lo = [0, 1, 2].map((k) => Math.min(...nodes.map((i) => ['x', 'y', 'z'].map((a) => s.nodes[i].centroid[a] - s.nodeSizes[i][a] / 2)[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...nodes.map((i) => ['x', 'y', 'z'].map((a) => s.nodes[i].centroid[a] + s.nodeSizes[i][a] / 2)[k])));
  // The face toward the street (north, +z): for a house its street wall at `near`.
  const x = t.kind === 'house' ? t.near[0] : (lo[0] + hi[0]) / 2;
  return { id: t.id, name: `${t.kind} ${best.group}`, group: best.group, aim: [+x.toFixed(3), t.y, +hi[2].toFixed(3)], face: 0, along: 'x', layer: t.layer ?? +(hi[2] - lo[2]).toFixed(2), town: true };
}

export function townMatrix(pack) {
  const out = [];
  for (const t of TOWN) {
    const target = townTarget(pack, t);
    for (const i of ['cannonball', 'meteor', 'ball100']) out.push({ ...trial(pack, target, i, '0'), scene: 'town' });
    if (['mailbox', 'tree', 'streetlight', 'town-house'].includes(t.id)) {
      const truck = trial(pack, { ...target, face: 80 }, 'truck20', '0');
      out.push({ ...truck, scene: 'town' });
    }
  }
  // The car parks on North Street's west end, out of the way of every shot.
  return out.map((t) => (t.drive.kind === 'park' ? { ...t, at: 'slot/-144,46,90', slot: [-144, 46, 90] } : t));
}

export function matrix(pack, set = 'all') {
  const T = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
  const out = [];
  const want = (s) => set === 'all' || set === s || (set === 'core' && s !== 'truck');
  // Angles: the weapons square on, 30, 60 and glancing, into the veneer house,
  // the masonry wall and the brick house.
  if (want('angles')) for (const t of ['veneer', 'masonry', 'brick-house']) for (const i of ['cannonball', 'meteor']) for (const a of Object.keys(ANGLES)) out.push(trial(pack, T[t], i, a));
  // Hit points: chunk centre, a seam, a joint.
  if (want('points')) for (const t of ['veneer', 'masonry']) for (const i of ['cannonball', 'ball100', 'meteor']) for (const p of ['seam', 'joint']) out.push(trial(pack, T[t], i, '0', p));
  // Every other target, square on.
  if (want('targets')) {
    for (const t of ['veneer-stud', 'veneer-corner', 'veneer-window', 'veneer-door', 'veneer-base', 'veneer-side', 'veneer-roof', 'masonry-base', 'masonry-end', 'brick-house-corner', 'stone-house', 'pile'])
      for (const i of ['cannonball', 'meteor', 'ball100']) out.push(trial(pack, T[t], i, '0'));
    for (const t of ['veneer', 'masonry', 'brick-house']) out.push(trial(pack, T[t], 'ball100', '0'), trial(pack, T[t], 'ball1000', '0'));
    // A wall already hit once.
    for (const t of ['veneer', 'masonry']) out.push(trial(pack, T[t], 'ball1000', '0', 'centre', { repeat: true, suffix: '-again' }));
  }
  // The truck: two speeds square on, 30 and 60 degrees, a corner, a window.
  if (want('truck')) {
    for (const t of ['veneer', 'masonry', 'brick-house']) for (const i of ['truck10', 'truck20']) out.push(trial(pack, T[t], i, '0'));
    for (const a of ['30', '60']) out.push(trial(pack, T.veneer, 'truck20', a));
    for (const t of ['veneer-corner', 'veneer-window', 'veneer-door']) out.push(trial(pack, T[t], 'truck20', '0'));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const packPath = arg('--pack', path.join(here, 'out/vehicle-lab.json'));
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  const meta = JSON.parse(readFileSync(packPath.replace(/\.json$/, '.meta.json'), 'utf8'));
  const town = arg('--scene', 'lab') === 'town';
  const trials = (town ? townMatrix(pack) : matrix(pack, arg('--set', 'all'))).map((t, index) => ({ ...t, index, slot: t.slot ?? (t.at.startsWith('slot/') ? t.at.slice(5).split(',').map(Number) : [110, -120, 0]) }));
  const out = arg('--out', path.join(here, 'out/wall-matrix.meta.json'));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...meta, trials, wallMatrix: { pack: packPath, targets: TARGETS, impactors: IMPACTORS } }, null, 1));
  console.log(`${out}: ${trials.length} trials`);
  for (const t of trials.slice(0, 400)) console.log(`  ${t.id.padEnd(44)} aim ${t.target.join(',')} chunk ${t.matrix.chunk?.type}/${t.matrix.chunk?.material} ${t.matrix.chunk?.mass?.toFixed(0)} kg`);
}
