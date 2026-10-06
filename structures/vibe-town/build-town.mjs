#!/usr/bin/env node
// Vibe Town (scripts/native-mac.sh --scene town): a filled-in town of ~70
// destructible buildings in two districts, built only from structures that
// converge and stand at rest at the city's 16 stress iterations
// (scripts/perf/qualify_structures.py over candidates.mjs, 2026-10-06):
//
//   west  Elm Park, residential: three streets of one- and two-storey houses
//         (the skyline houses: 0.7% / 2.3% of ticks unconverged) with front
//         paths, mailboxes, trees and driveways, some with a car in them
//   east  Market Quarter, commercial: rows of shops (strip shops 3-5%), corner
//         groceries (7%), a cinema (7%), a library (5%), five ten-storey towers
//         (6%), a bus station, a market square and a car park
//
// Left out because they do not converge at 16 iterations (per tick): the
// town-kit bungalow and porch house (~100%: the house never converges), the
// Victorian cafe (23-57%), the workshop (92%), the fire station (60%). Trees,
// the bus shelter and the market stall stand only with stronger bonds than the
// kit's cannon-tuned seams (strengthen.mjs; candidates.mjs --sweep).
//
// Everything above ground is destructible: buildings, roads, pavements,
// paint, fixtures. Only buried footings and road subgrade are fixed.
//
// Writes out/vibe-town.json (ScenePack v2), .visuals.json (tree leaves, stall
// canopies) and .slots (fleet parking spots with headings, for
// VIBE_CITY_FLEET_SLOTS: cars in driveways and the car park) and .meta.json
// (districts, parking and the named places films use: client/native/film).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildStripShop, buildCornerGrocery, buildNeighborhoodLibrary, buildArtDecoCinema, buildOutdoorProp, buildTree,
  composeScene,
} from '../town-kit/src/index.mjs';
import { Builder } from '../town-kit/src/geometry.mjs';
import { M } from '../town-kit/src/materials.mjs';
import { composeVisuals } from '../town-kit/src/outdoor-visuals.mjs';
import { dressTownProp } from '../town-kit/src/town-dressing-visuals.mjs';
import { strengthen } from './strengthen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const KEY = 'vibe-town';

// ---------------------------------------------------------------- the grid
// x east, z north. Roads are 8 m of asphalt with 2 m pavements each side.
const STREETS = [-48, 0, 48]; // east-west, z
const AVENUES = [-80, 0, 70]; // north-south, x
const WEST = -150, EAST = 150, SOUTH = -76, NORTH = 76;
const ROAD = 4, WALK = 6; // half widths: asphalt, asphalt + pavement

/** Bond strength factors (candidates.mjs --sweep: the smallest that stands, x3 margin; trees all at the shade tree's). */
const TREE_STRENGTH = 100, SHELTER_STRENGTH = 30, STALL_STRENGTH = 30;

// ------------------------------------------------------------- the ground
/** Streets, pavements, paths, driveways, paint: thin destructible surfacing on buried fixed subgrade. */
function buildGround({ paths }) {
  const b = new Builder('vibe-town-streets', { group: 'terrain' });
  const asphalt = b.table.push({ ...b.table[M.footing], name: 'asphalt-subgrade', color: '#4f5655', textureKey: null, roughness: 1 }) - 1;
  const paint = b.table.push({ ...b.table[M.footing], name: 'road-paint', color: '#e8ddac', textureKey: null, roughness: 0.95 }) - 1;
  const paving = b.table.push({ ...b.table[M.footing], name: 'pale-paving', color: '#c1b9a4', textureKey: 'concrete-wall', roughness: 1 }) - 1;
  const surfaces = [];
  /** Surfacing pieces about `piece` metres long; one fixed subgrade slab under each run. */
  const slab = (x0, x1, z0, z1, material, piece = 4) => {
    if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
    const top = material === paving ? 0.06 : 0.025;
    b.box({ min: [x0, -0.16, z0], max: [x1, 0, z1], material: M.footing, fixed: true, type: 'foundation' });
    const split = [Math.max(1, Math.round((x1 - x0) / piece)), 1, Math.max(1, Math.round((z1 - z0) / piece))];
    b.box({ min: [x0, 0, z0], max: [x1, top, z1], material, type: material === paving ? 'paving' : 'road', split });
    surfaces.push([x0, x1, z0, z1]);
  };
  const mark = (x0, x1, z0, z1) => b.box({ min: [x0, 0.025, z0], max: [x1, 0.027, z1], material: paint, type: 'road-marking' });
  /** [lo, hi] minus the cut-outs, as runs. */
  const runs = (lo, hi, cuts) => {
    const out = [];
    let at = lo;
    for (const [c0, c1] of [...cuts].sort((p, q) => p[0] - q[0])) {
      if (c0 > at) out.push([at, Math.min(c0, hi)]);
      at = Math.max(at, c1);
    }
    if (at < hi) out.push([at, hi]);
    return out;
  };

  // Streets run the full width; avenues stop at them.
  for (const z of STREETS) {
    slab(WEST, EAST, z - ROAD, z + ROAD, asphalt);
    for (const [x0, x1] of runs(WEST, EAST, AVENUES.map((x) => [x - WALK, x + WALK])))
      for (let x = x0 + 1.5; x + 3 <= x1 - 1.5; x += 7) mark(x, x + 3, z - 0.06, z + 0.06);
  }
  for (const x of AVENUES) {
    for (const [z0, z1] of runs(SOUTH, NORTH, STREETS.map((z) => [z - ROAD, z + ROAD]))) {
      slab(x - ROAD, x + ROAD, z0, z1, asphalt);
      for (const [d0, d1] of runs(z0, z1, STREETS.map((z) => [z - WALK, z + WALK])))
        for (let z = d0 + 1.5; z + 3 <= d1 - 1.5; z += 7) mark(x - 0.06, x + 0.06, z, z + 3);
    }
  }
  // Pavements: the streets' run through each crossing's corners; the avenues' stop at them.
  for (const z of STREETS)
    for (const side of [-1, 1])
      for (const [x0, x1] of runs(WEST, EAST, AVENUES.map((x) => [x - ROAD, x + ROAD])))
        slab(x0, x1, side < 0 ? z - WALK : z + ROAD, side < 0 ? z - ROAD : z + WALK, paving);
  for (const x of AVENUES)
    for (const side of [-1, 1])
      for (const [z0, z1] of runs(SOUTH, NORTH, STREETS.map((z) => [z - WALK, z + WALK])))
        slab(side < 0 ? x - WALK : x + ROAD, side < 0 ? x - ROAD : x + WALK, z0, z1, paving);
  // Zebra crossings on every approach to a Main Street crossing.
  for (const x of AVENUES)
    for (const side of [-1, 1]) {
      for (let k = -3; k <= 3; k += 1) {
        const zc = k * 1.05;
        const xa = x + side * (ROAD + 0.4);
        mark(Math.min(xa, xa + side * 1.6), Math.max(xa, xa + side * 1.6), zc - 0.25, zc + 0.25);
        const xc = x + k * 1.05, za = side * (ROAD + 0.4);
        mark(xc - 0.25, xc + 0.25, Math.min(za, za + side * 1.6), Math.max(za, za + side * 1.6));
      }
    }
  // Garden paths, driveways, the market square's walks and the car park.
  for (const [x0, x1, z0, z1, kind] of paths) slab(x0, x1, z0, z1, kind === 'asphalt' ? asphalt : paving);
  for (const [x0, x1, z0, z1] of paths.filter((p) => p[4] === 'asphalt'))
    for (let x = x0 + 3; x < x1 - 1; x += 3) mark(x - 0.06, x + 0.06, z0 + 0.5, z0 + 5.5);
  return { asset: { pack: b.build() }, surfaces };
}

// --------------------------------------------------------------- assets
const readPack = (file) => JSON.parse(readFileSync(path.join(repo, 'destruction/assets/scenes', file), 'utf8'));
/** A skyline scene pack as a town-kit asset (fills the arrays older packs lack). */
function skyline(file) {
  const pack = readPack(file);
  const s = pack.scenario, n = s.nodes.length;
  s.nodeGroups ??= Array(n).fill('building');
  s.nodePieces ??= s.nodes.map((_, i) => i);
  s.nodeMaterials ??= s.nodes.map((node) => pack.defaults.solver.materials[node.m ?? 0].name);
  return { pack };
}
/**
 * The ten-storey tower's facade, by style: its materials carry no colour or
 * texture (it draws plain grey). Looks only; strengths and masses unchanged.
 */
const TOWER_STYLES = {
  limestone: ['white-limestone', '#d9d0bd', 0.9],
  brick: ['brick', '#9b5b47', 0.9],
  glass: ['metal', '#6f8ea3', 0.35],
};
function dressTower(asset, style) {
  // Its nodes name no material: every piece draws (and weighs) as material 0.
  const [textureKey, color, roughness] = TOWER_STYLES[style];
  Object.assign(asset.pack.defaults.solver.materials[0], { textureKey, color, roughness });
  return asset;
}
const cache = new Map();
const once = (key, build) => { if (!cache.has(key)) cache.set(key, build()); return cache.get(key); };
const ASSETS = {
  house1: () => once('house1', () => skyline('house-1story.json')),
  house2: () => once('house2', () => skyline('house-2story.json')),
  tower: (style) => once(`tower-${style}`, () => dressTower(skyline('fractured-highrise-10f.json'), style)),
  shop: (sign, palette) => once(`shop-${sign}-${palette}`, () => buildStripShop({ furnished: false, signText: sign, palette })),
  grocery: (sign, palette) => once(`grocery-${sign}-${palette}`, () => buildCornerGrocery({ furnished: false, signText: sign, palette })),
  library: () => once('library', () => buildNeighborhoodLibrary({ furnished: false })),
  cinema: () => once('cinema', () => buildArtDecoCinema({ furnished: false })),
  tree: (family, variant) => once(`tree-${family}-${variant}`, () => strengthen(buildTree({ family, variant }), TREE_STRENGTH)),
  prop: (type) => once(`prop-${type}`, () => {
    const asset = dressTownProp(buildOutdoorProp(type), type, 0);
    return type === 'bus-shelter' ? strengthen(asset, SHELTER_STRENGTH)
      : type === 'market-stall' ? strengthen(asset, STALL_STRENGTH) : asset;
  }),
};

// ------------------------------------------------------------- the town
function layout() {
  const placements = [], paths = [], slots = [], labels = [];
  let n = 0;
  const place = (asset, x, z, yaw, name, y = 0) => placements.push({ ...asset, position: [x, y, z], yaw, group: `${name}@${name}-${n++}` });
  /** Faces the street: the kit's fronts are local -z. North of a street (side +1) yaw 0. */
  const facing = (side) => (side > 0 ? 0 : 180);
  /**
   * A building facing street z0 from `side`, its front (its local -z extent,
   * marquees and porticos included) `setback` metres from the road's centre.
   */
  const frontage = (asset, x, z0, side, setback, name) => {
    const s = asset.pack.scenario;
    let front = Infinity;
    s.nodes.forEach((node, i) => { if (node.mass > 0) front = Math.min(front, node.centroid.z - s.nodeSizes[i].z / 2); });
    const z = side > 0 ? z0 + setback - front : z0 - setback + front;
    place(asset, x, z, facing(side), name);
    return z;
  };

  // ---- Elm Park: houses on both sides of every street west of Main Avenue.
  const LOTS = [-134, -117, -100, -68, -51, -34, -17];
  // Narrow trees in the front gardens (4 m deep); wide ones out the back.
  const FRONT_TREES = [['street', 1], ['ornamental', 0], ['street', 0], ['sapling', 0], ['ornamental', 2], ['street', 2]];
  const BACK_TREES = [['shade', 0], ['conifer', 1], ['shade', 2], ['conifer', 0], ['shade', 1], ['conifer', 2]];
  const CARS = new Set(['0:1:1', '0:-1:4', '48:1:2', '48:-1:5', '-48:1:0', '-48:-1:3', '48:1:6', '-48:1:5']);
  let lot = 0;
  for (const z0 of STREETS)
    for (const side of [-1, 1])
      LOTS.forEach((x, i) => {
        const two = (lot * 7 + i) % 3 !== 0;
        frontage(two ? ASSETS.house2() : ASSETS.house1(), x, z0, side, 10.3, two ? 'house' : 'cottage');
        // Front path to the door; driveway down the east side.
        paths.push([x - 0.8, x + 0.8, ...[z0 + side * WALK, z0 + side * 10.2].sort((p, q) => p - q)]);
        paths.push([x + 6, x + 9.4, ...[z0 + side * WALK, z0 + side * 20].sort((p, q) => p - q)]);
        if (CARS.has(`${z0}:${side}:${i}`)) slots.push([x + 7.7, z0 + side * 13, side > 0 ? 180 : 0]);
        // Mailbox at the kerb of the garden, a tree in the front garden.
        place(ASSETS.prop('mailbox'), x + 4.5, z0 + side * 7.2, facing(side), 'mailbox');
        place(ASSETS.tree(...FRONT_TREES[(lot + i) % FRONT_TREES.length]), x - 3.4, z0 + side * 8.3, 0, 'tree');
        // Back gardens meet the next street's; only one row plants there.
        const back = side > 0 || z0 === STREETS[0];
        if (back && i % 2 === 0) place(ASSETS.tree(...BACK_TREES[(lot + i) % BACK_TREES.length]), x - 1, z0 + side * 24.5, 0, 'tree');
        lot += 1;
      });
  labels.push({ title: 'Elm Park', position: [-75, 0, 0] });

  // ---- Market Quarter, east of Main Avenue.
  const shopRow = (z0, side, x0, signs, palettes) => signs.forEach((sign, k) => {
    // Strip shops are 6 m wide and 10 m deep; 0.4 m between them.
    frontage(ASSETS.shop(sign, palettes[k % palettes.length]), x0 + k * 6.4, z0, side, 7.4, `shop-${sign.toLowerCase()}`);
  });
  // Main Street north: a row of shops, then the cinema, library and a grocer.
  shopRow(0, 1, 10, ['BOOKS', 'CAFE', 'BAKERY', 'DELI', 'TOYS', 'FLORIST', 'BARBER', 'CAFE'], ['cream', 'sage', 'rose', 'blue', 'ochre', 'slate']);
  frontage(ASSETS.cinema(), 86, 0, 1, 7.4, 'cinema');
  frontage(ASSETS.library(), 108, 0, 1, 7.4, 'library');
  frontage(ASSETS.grocery('GROCER', 'ochre'), 132, 0, 1, 7.4, 'grocery');
  // Main Street south: the bus station and a grocer; the towers beyond the avenue.
  for (const [k, x] of [12, 20, 28].entries()) place(ASSETS.prop('bus-shelter'), x, -8.2, 180, 'bus-shelter');
  for (const x of [8.5, 16, 24, 31.5]) place(ASSETS.prop('bollard'), x, -7.2, 0, 'bollard');
  place(ASSETS.prop('street-sign'), 35, -7.4, 180, 'bus-sign');
  for (const x of [13, 21, 29]) place(ASSETS.prop('bench'), x, -14, 180, 'bench');
  frontage(ASSETS.grocery('MARKET', 'rose'), 52, 0, -1, 7.4, 'grocery');
  for (const [k, x] of [90, 112, 134].entries()) frontage(ASSETS.tower(['limestone', 'glass', 'brick'][k]), x, 0, -1, 8, 'tower');
  labels.push({ title: 'Bus station', position: [20, 0, -10] });
  // North Street: shops facing south; the market square behind Main Street's shops.
  shopRow(48, -1, 10, ['DELI', 'BOOKS', 'BAKERY', 'CAFE', 'TOYS', 'FLORIST', 'BARBER'], ['slate', 'blue', 'cream', 'sage', 'rose']);
  for (const [k, x] of [12, 22, 32, 42].entries()) place(ASSETS.prop('market-stall'), x, 22.5, k % 2 ? 0 : 0, 'market-stall');
  paths.push([8, 46, 26, 28.5]);
  for (const x of [17, 27, 37]) place(ASSETS.prop('bench'), x, 25, 180, 'bench');
  for (const x of [6, 48]) place(ASSETS.prop('planter'), x, 25, 0, 'planter');
  place(ASSETS.prop('bike-rack'), 51, 22, 90, 'bike-rack');
  for (const [k, x] of [54, 60].entries()) place(ASSETS.tree(['shade', 'ornamental'][k], k), x, 25, 0, 'tree');
  labels.push({ title: 'Market square', position: [27, 0, 24] });
  // North Street east: two towers and the car park between them.
  for (const [k, x] of [90, 134].entries()) frontage(ASSETS.tower(['glass', 'limestone'][k]), x, 48, 1, 8, 'tower');
  paths.push([100, 124, 55, 70, 'asphalt']);
  slots.push([106.5, 63, 180], [115.5, 63, 180]);
  place(ASSETS.prop('billboard'), 112, 73, 0, 'billboard');
  // South Street: shops facing north, then a grocer; a library-sized green with trees.
  shopRow(-48, 1, 10, ['CAFE', 'TOYS', 'BOOKS', 'DELI', 'BAKERY', 'BARBER', 'FLORIST'], ['sage', 'ochre', 'blue', 'rose', 'cream']);
  frontage(ASSETS.grocery('GROCER', 'sage'), 86, -48, 1, 7.4, 'grocery');
  for (const [k, x] of [104, 114, 124, 134, 144].entries()) place(ASSETS.tree(['shade', 'street', 'conifer', 'ornamental', 'shade'][k], k % 3), x, -36, 0, 'tree');
  labels.push({ title: 'Market Quarter', position: [70, 0, 0] });

  // ---- Street furniture: lights along every street and avenue, hydrants, signs.
  const trees = placements.filter((p) => p.group.startsWith('tree@')).map((p) => p.position);
  const clear = (x, z) => !paths.some(([x0, x1, z0, z1]) => x > x0 - 0.8 && x < x1 + 0.8 && z > z0 - 0.8 && z < z1 + 0.8)
    && !trees.some(([tx, , tz]) => Math.hypot(tx - x, tz - z) < 3.5);
  for (const z0 of STREETS)
    for (const side of [-1, 1])
      for (let x = WEST + 10; x < EAST - 4; x += 26) {
        const xl = x + (side > 0 ? 0 : 13), zl = z0 + side * 6.7;
        if (AVENUES.some((a) => Math.abs(xl - a) < 10)) continue;
        if (clear(xl, zl) && !(z0 === 0 && side < 0 && xl > 4 && xl < 40)) place(ASSETS.prop('streetlight'), xl, zl, facing(side), 'streetlight');
      }
  for (const x of AVENUES)
    for (const side of [-1, 1])
      // Between the house rows: their back gardens meet at +-24.
      for (const z of [-70, -24, 24, 70]) {
        if (!clear(x + side * 6.7, z)) continue;
        place(ASSETS.prop('streetlight'), x + side * 6.7, z, side > 0 ? 270 : 90, 'streetlight');
      }
  for (const x of AVENUES)
    for (const z of STREETS) {
      place(ASSETS.prop('street-sign'), x - 6.9, z + 6.9, 0, 'street-sign');
      if (clear(x + 6.9, z - 6.9)) place(ASSETS.prop('hydrant'), x + 6.9, z - 6.9, 0, 'hydrant');
    }
  return { placements, paths, slots, labels };
}

// ---------------------------------------------------------- the checks
/** Every placement's above-ground box, from its composed nodes. */
function boxes(placements, pack) {
  const s = pack.scenario, out = [];
  let offset = 0;
  for (const p of placements) {
    const count = p.pack.scenario.nodes.length;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const footLo = [Infinity, Infinity, Infinity], footHi = [-Infinity, -Infinity, -Infinity];
    let anchored = false;
    for (let i = offset; i < offset + count; i += 1) {
      const c = s.nodes[i].centroid, h = s.nodeSizes[i];
      if (s.nodes[i].mass === 0) { anchored = true; continue; }
      const extent = [[c.x, h.x], [c.y, h.y], [c.z, h.z]];
      extent.forEach(([q, size], k) => { lo[k] = Math.min(lo[k], q - size / 2); hi[k] = Math.max(hi[k], q + size / 2); });
      // What stands at ground level: a crown above a pavement is no clash.
      if (c.y - h.y / 2 < 0.3) extent.forEach(([q, size], k) => { footLo[k] = Math.min(footLo[k], q - size / 2); footHi[k] = Math.max(footHi[k], q + size / 2); });
    }
    out.push({ group: p.group, lo, hi, footLo, footHi, anchored });
    offset += count;
  }
  return out;
}

/** No two placements overlap; nothing anchored stands on paving (its footing would lift it). */
function check(placements, pack, surfaces) {
  const all = boxes(placements, pack), problems = [];
  const items = all.filter((b) => b.group !== 'terrain@terrain-0' && Number.isFinite(b.lo[0]));
  const overlap = (a, b, pad = 0.02) => [0, 1, 2].every((k) => a.lo[k] < b.hi[k] - pad && b.lo[k] < a.hi[k] - pad);
  for (let i = 0; i < items.length; i += 1)
    for (let j = i + 1; j < items.length; j += 1)
      if (overlap(items[i], items[j])) problems.push(`${items[i].group} overlaps ${items[j].group}`);
  for (const item of items.filter((b) => b.anchored && Number.isFinite(b.footLo[0])))
    for (const [x0, x1, z0, z1] of surfaces)
      if (item.footLo[0] < x1 - 0.02 && x0 < item.footHi[0] - 0.02 && item.footLo[2] < z1 - 0.02 && z0 < item.footHi[2] - 0.02)
        { problems.push(`${item.group} stands on paving [${x0}, ${x1}] x [${z0}, ${z1}]`); break; }
  return problems;
}

// --------------------------------------------------------------- places
const STREET_NAMES = { [-48]: 'South Street', 0: 'Main Street', 48: 'North Street' };
const AVENUE_NAMES = { [-80]: 'West Avenue', 0: 'Main Avenue', 70: 'East Avenue' };
const BUILDINGS = /^(house|cottage|shop-.*|cinema|library|grocery|tower)$/;
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const round = (v) => Math.round(v * 100) / 100;

/**
 * Named places for scripts (client/native/film): every building (its id,
 * kind, footprint centre, bounds, top and street), every parking spot
 * (`car-N`, the N-th fleet slot: the N-th destructible car), the streets and
 * the districts. Building ids number each kind within its district in build
 * order: `elm-park/house-12`, `market-quarter/shop-3`, `market-quarter/tower-2`.
 */
function namePlaces(placements, pack, slots, labels) {
  const places = [], counts = {};
  const nearestStreet = (z) => STREETS.reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
  for (const box of boxes(placements, pack)) {
    const [name] = box.group.split('@');
    if (!BUILDINGS.test(name) || !Number.isFinite(box.lo[0])) continue;
    const district = (box.lo[0] + box.hi[0]) / 2 < 0 ? 'elm-park' : 'market-quarter';
    const kind = name === 'cottage' ? 'house' : name.startsWith('shop-') ? 'shop' : name;
    const key = `${district}/${kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const x = (box.lo[0] + box.hi[0]) / 2, z = (box.lo[2] + box.hi[2]) / 2;
    const z0 = nearestStreet(z), side = Math.sign(z - z0);
    places.push({
      id: `${key}-${counts[key]}`, kind, district,
      ...(name.startsWith('shop-') ? { sign: name.slice(5) } : {}),
      ...(kind === 'house' ? { storeys: name === 'cottage' ? 1 : 2 } : {}),
      street: STREET_NAMES[z0], side: side > 0 ? 'north' : 'south',
      position: [round(x), 0, round(z)],
      footprint: [round(box.hi[0] - box.lo[0]), round(box.hi[2] - box.lo[2])],
      min: box.lo.map(round), max: box.hi.map(round), top: round(box.hi[1]),
      // The pavement in front of it, at eye height.
      pavement: [round(x), 1.6, z0 + side * (ROAD + 1)],
    });
  }
  const buildings = [...places];
  slots.forEach(([x, z, heading], n) => {
    const house = buildings.reduce((a, b) => (Math.hypot(b.position[0] - x, b.position[2] - z) < Math.hypot(a.position[0] - x, a.position[2] - z) ? b : a));
    places.push({ id: `car-${n}`, kind: 'car', position: [x, 0, z], heading, house: house.id });
  });
  for (const [z, name] of Object.entries(STREET_NAMES))
    places.push({ id: `street/${slug(name)}`, kind: 'street', name, from: [WEST, 0, Number(z)], to: [EAST, 0, Number(z)], position: [0, 0, Number(z)] });
  for (const [x, name] of Object.entries(AVENUE_NAMES))
    places.push({ id: `street/${slug(name)}`, kind: 'street', name, from: [Number(x), 0, SOUTH], to: [Number(x), 0, NORTH], position: [Number(x), 0, 0] });
  for (const { title, position } of labels) places.push({ id: slug(title), kind: 'district', name: title, position });
  return places;
}

// --------------------------------------------------------------- build
export function buildTown() {
  const { placements, paths, slots, labels } = layout();
  const { asset: ground, surfaces } = buildGround({ paths });
  const all = [{ ...ground, position: [0, 0, 0], yaw: 0, group: 'terrain@terrain-0' }, ...placements];
  const pack = composeScene(all, { key: KEY, title: 'Vibe Town' });
  // The ground is ungrouped (`ground` to the qualifier); everything else is `kind@name-n`.
  pack.scenario.nodeGroups = pack.scenario.nodeGroups.map((g) => (g === 'terrain@terrain-0' ? 'terrain' : g));
  const problems = check(all, pack, surfaces);
  const visuals = composeVisuals(all, pack);
  // One instanced mesh per (tree mesh, cell), and three's WebGPU renderer pays
  // per object in every pass, shadow cascades included; the GPU has room for
  // more instances per draw. The kit's 32 m cells made 514 leaf meshes.
  for (const attachment of visuals.attachments) attachment.cell = attachment.cell.map((c) => Math.floor(c / 4));
  return { pack, visuals, slots, labels, problems, placements: all, places: namePlaces(all, pack, slots, labels) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pack, visuals, slots, labels, problems, placements, places } = buildTown();
  if (problems.length) {
    console.error(problems.slice(0, 40).join('\n'));
    throw new Error(`${problems.length} placement problems`);
  }
  const nodes = pack.scenario.nodes.length;
  if (nodes > 65536) throw new Error(`${nodes} nodes: over one structure's 65,536`);
  const out = path.join(here, 'out');
  mkdirSync(out, { recursive: true });
  const bytes = JSON.stringify(pack);
  writeFileSync(path.join(out, `${KEY}.json`), bytes);
  writeFileSync(path.join(out, `${KEY}.visuals.json`), JSON.stringify({
    // No label sprites: the client draws them on a DOM canvas the native app
    // lacks, and a failed label leaves every tree bare. Districts go in .meta.
    ...visuals, nodeCount: nodes, labels: [], title: 'Vibe Town',
    description: 'Elm Park houses with cars in the driveways, and the Market Quarter: shops, towers, a cinema, a library, a bus station and a market square',
  }));
  writeFileSync(path.join(out, `${KEY}.slots`), slots.map((s) => s.join(',')).join(';'));
  writeFileSync(path.join(out, `${KEY}.meta.json`), JSON.stringify({ districts: labels, parking: slots, places }, null, 1));
  const kinds = {};
  for (const p of placements) { const k = p.group.split('@')[0]; kinds[k] = (kinds[k] ?? 0) + 1; }
  console.log(`${KEY}: ${nodes} nodes, ${pack.scenario.bonds.length} bonds, ${placements.length - 1} placements, ${slots.length} parking spots`);
  console.log(Object.entries(kinds).map(([k, c]) => `${k} ${c}`).join(', '));
}
