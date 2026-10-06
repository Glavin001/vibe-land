// The showcase scene: one pack composed from structures that converge at
// rest, with static terrain to drive on and jump from.
//
//   node structures/showcase/build-showcase.mjs
//   -> structures/showcase/out/vibe-showcase.json (+ .visuals.json)
//
// Every structure here passes scripts/perf/qualify_structures.py at the
// scene's 16 stress iterations: its solve converges at rest in all but ~10% of
// solves over 5 s, and it stands (<= 0.5% of its bonds broken). One that does
// not converge keeps the GPU re-solving it every idle tick -- the stage skips
// only converged structures -- which is what made the first showcase idle at
// ~12 ms (2026-10-05); one that does not stand falls down at every start.
//
// Bayline Town with Gardens & Market (structures/town-kit, built with
// `npm run build:bayline-gardens`) sits at the origin, minus TOWN_EXCLUDE;
// its visuals sidecar (trees, attached details) names nodes by index, so its
// attachments are remapped and those on removed nodes dropped. After it:
//
//   two houses            east: one storey and two storeys
//   fractured high-rise   north: ten storeys of Voronoi concrete, to topple
//   two-storey house      south-west, on a plateau with a ramp up its east side
//   jump kicker           on the west approach, launching cars into the town
//
// Each authored pack's material table is appended once per distinct table,
// indices remapped. The terrain is static support nodes (mass 0, no bonds) with
// box or wedge colliders: the city has no heightfield (a PhysX GPU fault at its
// edge, .claude/skills/native-destruction-faults), and static blocks give
// ramps and plateaus without one.
//
// Spacing keeps every building further from the next than its own height.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mortarJoints } from '../town-kit/src/materials.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(repo, 'structures/showcase/out');
const KEY = 'vibe-showcase';
const TOWN = path.join(repo, 'structures/town-kit/out/bayline-town-with-gardens-and-market');
const SCENES = path.join(repo, 'destruction/assets/scenes');

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
/**
 * SHOWCASE_EXCLUDE=highrise,juniper-house,terrain leaves parts out, to measure
 * what each costs: a part of an authored building's group, a Bayline structure
 * by name, or `terrain`.
 */
const EXCLUDE = new Set((process.env.SHOWCASE_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const round = (n) => Math.round(n * 1e5) / 1e5;

/**
 * Bayline structures left out (qualify_structures.py, 5 s at rest, 16
 * iterations): the foundry workshop does not converge (19% of solves); these
 * props converge but fall apart by themselves (share of bonds broken) -- the
 * five trees (79-87%), the scaffold (70%), the bus shelter (40%), the two
 * market stalls (17%) and the billboard. Together they were the ~280 bonds the
 * town broke at every start.
 */
const TOWN_EXCLUDE = [
  'foundry-workshop',
  'gardens-market-3', 'gardens-market-19', 'gardens-market-30', 'gardens-market-35', 'gardens-market-47', // trees
  'gardens-market-38', // scaffold
  'gardens-market-21', // bus shelter
  'gardens-market-8', 'gardens-market-9', // market stalls
  'gardens-market-45', // billboard
  // Just over the line: 10.0-10.2% of solves unconverged, residuals ~430,000x
  // tolerance, 0.24% of bonds broken; together 5.5 ms of idle PhysX and ~60
  // bonds broken at every start (scene shots, 2026-10-05). Their plots get
  // qualified houses (BUILDINGS).
  'amber-house', 'juniper-house', 'willow-house',
];

/**
 * Authored buildings appended after the town: [pack file, offset, group], each
 * with its measured unconverged share at rest (all break nothing). Replaced the
 * parking garage and Villa Savoye (28% unconverged each) and the Algedra tower
 * (18% of its bonds broken at rest).
 */
const BUILDINGS = [
  ['house-1story.json', [110, 0, -12], 'building@east-bungalow'],              // 0.7%
  ['house-2story.json', [110, 0, 18], 'building@east-house'],                  // 2.3%
  ['fractured-highrise-10f.json', [0, 0, -110], 'building@fractured-highrise'], // 5.7%
  ['house-2story.json', [-105, 6, 75], 'building@hill-house'],                  // 2.3%
  // On the plots of Bayline's three family houses (TOWN_EXCLUDE).
  ['house-2story.json', [33, 0, -16.5], 'building@amber-house'],               // 2.3%
  ['house-1story.json', [-14, 0, -17], 'building@willow-house'],               // 0.7%
  ['house-2story.json', [-33, 0, 16.7], 'building@juniper-house'],             // 2.3%
];

/**
 * Static terrain. A box is [centre, half extents]; a wedge rises along +x or
 * -x / +z or -z from 0 to `height` over its run (`from` -> `to`, the high end
 * at `to`), `width` across.
 */
const TERRAIN = [
  // The hill house's plateau, 34 x 34 m, 6 m high.
  { name: 'plateau', box: { centre: [-105, 3, 75], half: [17, 3, 17] } },
  // Up the plateau's east side, 30 m long (11 degrees).
  { name: 'plateau ramp', wedge: { axis: 'x', from: -58, to: -88, across: [60, 68], height: 6 } },
  // A kicker on the west road: 12 m, 2.6 m high, launching east into town.
  { name: 'jump kicker', wedge: { axis: 'x', from: -96, to: -84, across: [-4, 4], height: 2.6 } },
];

function wedgeNode({ axis, from, to, across, height }) {
  // Corner points in world space, then made relative to the centroid.
  const [a0, a1] = across;
  const pt = (along, y, side) => (axis === 'x' ? [along, y, side] : [side, y, along]);
  const corners = [
    pt(from, 0, a0), pt(from, 0, a1),
    pt(to, 0, a0), pt(to, 0, a1),
    pt(to, height, a0), pt(to, height, a1),
  ];
  // A triangular prism's centroid: a third of the way from the high end's base.
  const along = to + (from - to) / 3;
  const centre = axis === 'x' ? [along, height / 3, (a0 + a1) / 2] : [(a0 + a1) / 2, height / 3, along];
  const points = corners.flatMap((c) => c.map((v, i) => round(v - centre[i])));
  const length = Math.abs(to - from);
  const width = Math.abs(a1 - a0);
  return {
    centre,
    collider: { kind: 'convex_hull', points },
    size: axis === 'x' ? { x: length, y: height, z: width } : { x: width, y: height, z: length },
    volume: 0.5 * length * height * width,
  };
}

function boxNode({ centre, half }) {
  return {
    centre,
    collider: { kind: 'cuboid', halfExtents: { x: half[0], y: half[1], z: half[2] } },
    size: { x: half[0] * 2, y: half[1] * 2, z: half[2] * 2 },
    volume: 8 * half[0] * half[1] * half[2],
  };
}

function build() {
  const town = read(`${TOWN}.json`);
  const visuals = read(`${TOWN}.visuals.json`);
  if (visuals.nodeCount !== town.scenario.nodes.length) throw new Error('the town and its visuals disagree on the node count');
  const structureOf = (group) => (group.includes('@') ? group.split('@')[1] : 'ground');
  const keep = town.scenario.nodeGroups.map((g, i) => (TOWN_EXCLUDE.includes(structureOf(g)) || EXCLUDE.has(structureOf(g)) ? -1 : i)).filter((i) => i >= 0);
  const remap = new Map(keep.map((old, i) => [old, i]));
  const s = Object.fromEntries(Object.entries(town.scenario).map(([key, value]) => [key,
    key === 'bonds'
      ? value.filter((b) => remap.has(b.node0) && remap.has(b.node1)).map((b) => ({ ...b, node0: remap.get(b.node0), node1: remap.get(b.node1) }))
      : Array.isArray(value) && value.length === town.scenario.nodes.length ? keep.map((i) => value[i]) : value]));
  const attachments = visuals.attachments.filter((a) => remap.has(a.owner)).map((a) => ({ ...a, owner: remap.get(a.owner) }));
  console.log(`town: ${s.nodes.length} of ${town.scenario.nodes.length} nodes (without ${TOWN_EXCLUDE.join(', ')}), ${attachments.length} of ${visuals.attachments.length} attachments`);

  const materials = [...town.defaults.solver.materials];
  const out = {
    nodes: [...s.nodes], bonds: [...s.bonds], nodeSizes: [...s.nodeSizes], nodeColliders: [...s.nodeColliders],
    nodeTypes: [...s.nodeTypes], nodeMaterials: [...s.nodeMaterials], nodePieces: [...s.nodePieces],
    nodeGroups: [...s.nodeGroups], shapeLibrary: [...s.shapeLibrary],
  };
  let pieceBase = Math.max(...s.nodePieces) + 1;

  // The authored buildings: each distinct material table appended once.
  const tables = new Map();
  for (const [file, at, group] of BUILDINGS) {
    if ([...EXCLUDE].some((part) => group.includes(part))) continue;
    const pack = read(path.join(SCENES, file));
    const table = pack.defaults.solver.materials;
    mortarJoints(pack); // masonry joints at mortar strength (town-kit materials.mjs)
    if (!table) throw new Error(`${file} has no material table to merge`);
    const names = table.map((m) => m.name).join(',');
    if (!tables.has(names)) {
      tables.set(names, materials.length);
      materials.push(...table);
    }
    const tableBase = tables.get(names);
    const p = pack.scenario;
    const nodeBase = out.nodes.length;
    const shapeBase = out.shapeLibrary.length;
    for (const node of p.nodes) {
      out.nodes.push({
        centroid: { x: round(node.centroid.x + at[0]), y: round(node.centroid.y + at[1]), z: round(node.centroid.z + at[2]) },
        mass: node.mass, volume: node.volume, m: (node.m ?? 0) + tableBase,
      });
    }
    for (const bond of p.bonds) {
      out.bonds.push({
        ...bond,
        node0: bond.node0 + nodeBase, node1: bond.node1 + nodeBase,
        centroid: { x: round(bond.centroid.x + at[0]), y: round(bond.centroid.y + at[1]), z: round(bond.centroid.z + at[2]) },
        m: (bond.m ?? 0) + tableBase,
      });
    }
    out.nodeSizes.push(...p.nodeSizes);
    out.nodeColliders.push(...p.nodeColliders.map((c) => (c.kind === 'shape' ? { ...c, shape: c.shape + shapeBase } : c)));
    // Older packs carry no per-node materials, pieces or groups: material 0 of
    // their table (the loader's default), one piece per node.
    out.nodeTypes.push(...p.nodeTypes);
    out.nodeMaterials.push(...(p.nodeMaterials ?? p.nodes.map((n) => table[n.m ?? 0].name)));
    out.nodePieces.push(...(p.nodePieces ?? p.nodes.map((_, i) => i)).map((piece) => piece + pieceBase));
    out.nodeGroups.push(...p.nodes.map(() => group));
    out.shapeLibrary.push(...(p.shapeLibrary ?? []));
    pieceBase = Math.max(...out.nodePieces) + 1;
    console.log(`${file}: ${p.nodes.length} nodes at ${at.join(', ')}`);
  }

  // Terrain: static stone, one node each, no bonds.
  const stone = materials.findIndex((m) => m.name === 'stone');
  if (stone < 0 && !EXCLUDE.has('terrain')) throw new Error('no stone material for the terrain');
  for (const piece of EXCLUDE.has('terrain') ? [] : TERRAIN) {
    const node = piece.box ? boxNode(piece.box) : wedgeNode(piece.wedge);
    out.nodes.push({ centroid: { x: round(node.centre[0]), y: round(node.centre[1]), z: round(node.centre[2]) }, mass: 0, volume: round(node.volume), m: stone });
    out.nodeSizes.push(node.size);
    out.nodeColliders.push(node.collider);
    out.nodeTypes.push('terrain');
    out.nodeMaterials.push('stone');
    out.nodePieces.push(pieceBase++);
    out.nodeGroups.push(`terrain@${piece.name}`);
  }
  console.log(`terrain: ${EXCLUDE.has('terrain') ? 0 : TERRAIN.length} static pieces${EXCLUDE.size ? ` (excluded: ${[...EXCLUDE].join(', ')})` : ''}`);

  const pack = {
    version: town.version,
    key: KEY,
    title: 'Vibe Land Showcase - Bayline Heights',
    defaults: { ...town.defaults, solver: { ...town.defaults.solver, materials } },
    scenario: out,
  };
  if (out.nodes.length > 65536) throw new Error(`${out.nodes.length} nodes: over one structure's 65,536`);

  mkdirSync(OUT, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(pack));
  writeFileSync(path.join(OUT, `${KEY}.json`), bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(OUT, `${KEY}.visuals.json`), JSON.stringify({
    ...visuals,
    attachments,
    physicsSha256: sha,
    nodeCount: out.nodes.length,
    title: 'Vibe Land Showcase - Bayline Heights',
    description: 'Bayline Town, a ten-storey high-rise, houses on the east road and on a hill, and a jump',
  }));
  // What this pack leaves out, so the launcher rebuilds when that changes.
  writeFileSync(path.join(OUT, `${KEY}.exclude`), process.env.SHOWCASE_EXCLUDE ?? '');
  console.log(`${KEY}: ${out.nodes.length} nodes, ${out.bonds.length} bonds, ${materials.length} materials -> ${path.relative(repo, OUT)}`);
}

build();
