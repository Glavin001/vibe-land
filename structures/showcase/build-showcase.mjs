// The showcase scene: one pack composed from content that stands on its own,
// with static terrain to drive on and jump from.
//
//   node structures/showcase/build-showcase.mjs
//   -> structures/showcase/out/vibe-showcase.json (+ .visuals.json)
//
// Bayline Town with Gardens & Market (structures/town-kit, built with
// `npm run build:bayline-gardens`) sits at the origin, unchanged and first, so
// its visuals sidecar (trees, attached details), which names nodes by index,
// still applies; only its node count and physics hash are rewritten. After it:
//
//   parking garage   east, with a ramp from the south up to its roof deck
//   Villa Savoye     south-west, on a plateau with a ramp up its east side
//   jump kicker      on the west approach, launching cars into the town
//
// The garage and the villa are authored packs from the skyline set
// (destruction/assets/scenes/, both stand on their own); they share one
// material table, appended after Bayline's with indices remapped. The terrain
// is static support nodes (mass 0, no bonds) with box or wedge colliders: the
// city has no heightfield (a PhysX GPU fault at its edge,
// .claude/skills/native-destruction-faults), and static blocks give ramps
// and plateaus without one.
//
// Spacing keeps every building further from the next than its own height.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(repo, 'structures/showcase/out');
const KEY = 'vibe-showcase';
const TOWN = path.join(repo, 'structures/town-kit/out/bayline-town-with-gardens-and-market');
const SCENES = path.join(repo, 'destruction/assets/scenes');

const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
/** SHOWCASE_EXCLUDE=garage,villa,terrain leaves parts out, to measure what each costs. */
const EXCLUDE = new Set((process.env.SHOWCASE_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const round = (n) => Math.round(n * 1e5) / 1e5;

/** Authored buildings appended after the town: [pack file, offset, group]. */
const BUILDINGS = [
  ['parking-garage.json', [110, 0, 0], 'building@parking-garage'],
  ['villa-savoye.json', [-105, 6, 75], 'building@villa-savoye'],
];

/** The garage roof deck's top (its highest slab, 16.25 m, plus half its 0.3 m). */
const GARAGE_ROOF_Y = 16.4;

/**
 * Static terrain. A box is [centre, half extents]; a wedge rises along +x or
 * -x / +z or -z from 0 to `height` over its run (`from` -> `to`, the high end
 * at `to`), `width` across.
 */
const TERRAIN = [
  // The villa's plateau, 34 x 34 m, 6 m high.
  { name: 'plateau', box: { centre: [-105, 3, 75], half: [17, 3, 17] } },
  // Up the plateau's east side, 30 m long (11 degrees).
  { name: 'plateau ramp', wedge: { axis: 'x', from: -58, to: -88, across: [60, 68], height: 6 } },
  // From the south up to the garage roof, 70 m long (13 degrees), meeting
  // the deck at its edge -- the parapet is in the way, and breaks.
  { name: 'garage ramp', wedge: { axis: 'z', from: 86, to: 16, across: [92, 100], height: GARAGE_ROOF_Y } },
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
  const s = town.scenario;
  if (visuals.nodeCount !== s.nodes.length) throw new Error('the town and its visuals disagree on the node count');

  const materials = [...town.defaults.solver.materials];
  const out = {
    nodes: [...s.nodes], bonds: [...s.bonds], nodeSizes: [...s.nodeSizes], nodeColliders: [...s.nodeColliders],
    nodeTypes: [...s.nodeTypes], nodeMaterials: [...s.nodeMaterials], nodePieces: [...s.nodePieces],
    nodeGroups: [...s.nodeGroups], shapeLibrary: [...s.shapeLibrary],
  };
  let pieceBase = Math.max(...s.nodePieces) + 1;

  // The authored buildings: one shared material table, appended once.
  let tableBase = -1;
  let tableNames = null;
  for (const [file, at, group] of BUILDINGS) {
    if ([...EXCLUDE].some((part) => group.includes(part))) continue;
    const pack = read(path.join(SCENES, file));
    const table = pack.defaults.solver.materials;
    const names = table.map((m) => m.name).join(',');
    if (tableBase < 0) {
      tableBase = materials.length;
      tableNames = names;
      materials.push(...table);
    } else if (names !== tableNames) {
      throw new Error(`${file} has its own material table; it would need its own remapping`);
    }
    const p = pack.scenario;
    const nodeBase = out.nodes.length;
    const shapeBase = out.shapeLibrary.length;
    for (const node of p.nodes) {
      out.nodes.push({
        centroid: { x: round(node.centroid.x + at[0]), y: round(node.centroid.y + at[1]), z: round(node.centroid.z + at[2]) },
        mass: node.mass, volume: node.volume, m: node.m + tableBase,
      });
    }
    for (const bond of p.bonds) {
      out.bonds.push({
        ...bond,
        node0: bond.node0 + nodeBase, node1: bond.node1 + nodeBase,
        centroid: { x: round(bond.centroid.x + at[0]), y: round(bond.centroid.y + at[1]), z: round(bond.centroid.z + at[2]) },
        m: bond.m + tableBase,
      });
    }
    out.nodeSizes.push(...p.nodeSizes);
    out.nodeColliders.push(...p.nodeColliders.map((c) => (c.kind === 'shape' ? { ...c, shape: c.shape + shapeBase } : c)));
    out.nodeTypes.push(...p.nodeTypes);
    out.nodeMaterials.push(...p.nodeMaterials);
    out.nodePieces.push(...p.nodePieces.map((piece) => piece + pieceBase));
    out.nodeGroups.push(...p.nodeGroups.map(() => group));
    out.shapeLibrary.push(...p.shapeLibrary);
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
    physicsSha256: sha,
    nodeCount: out.nodes.length,
    title: 'Vibe Land Showcase - Bayline Heights',
    description: 'Bayline Town, a parking garage with a roof ramp, Villa Savoye on a hill, and a jump',
  }));
  console.log(`${KEY}: ${out.nodes.length} nodes, ${out.bonds.length} bonds, ${materials.length} materials -> ${path.relative(repo, OUT)}`);
}

build();
