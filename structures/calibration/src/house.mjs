/**
 * Calibration 2 (docs/calibration/house-studs.md): the town kit's brick-veneer
 * bungalow (structures/town-kit/src/veneer-houses.mjs, built as the kit
 * builds it, not edited here) with the studs of its front wall taken out one
 * at a time, from the middle of its longest plain run outwards.
 *
 * What carries the front wall's load. The roof is a couple roof: each rafter
 * pair is tied at its feet by a ceiling joist (bolted heel), so its weight
 * goes half to each eaves wall and the ridge board carries nothing; each
 * ceiling joist spans from the eaves wall to the centre wall. Every rafter
 * seat and joist end is a point load on the doubled 90 x 90 C24 top plate,
 * which spans between the studs under it (studs at 600 mm, end-nailed: a
 * pinned support). Take studs out and the plate spans the gap; it fails in
 * bending at f_m,k = 24 MPa (EN 338, C24), sustained at k_mod 0.6 (the kit's
 * `elastic`, materials.mjs LONG_TERM).
 *
 * As authored, a top plate is one chunk per 2.4 m (veneer-houses frameWall
 * `plate`), so the stage checks its bending only at those seams: a plate
 * chunk over a gap is rigid. `rechunk` splits the front top plate into
 * shorter chunks (each bond re-hung on the piece it bears on, a new full-
 * section C24 bond at every cut), so the plate's bending is checked where the
 * hand calculation checks it. Both are run.
 */
import { frame } from './frame2d.mjs';
import { buildVeneerHouse, withoutNodes, withoutSkin } from '../../town-kit/src/veneer-houses.mjs';

const G = 9.81;
const STUDS = new Set(['stud', 'king-stud', 'jack-stud', 'cripple-stud', 'junction-stud']);

/** A node's axis-aligned bounds [lo, hi] in pack coordinates. */
export function aabb(s, i) {
  const c = s.nodes[i].centroid, p = [c.x, c.y, c.z];
  let col = s.nodeColliders[i];
  if (col.kind === 'shape') col = s.shapeLibrary[col.shape];
  if (col.kind === 'cuboid') { const h = [col.halfExtents.x, col.halfExtents.y, col.halfExtents.z]; return [p.map((x, k) => x - h[k]), p.map((x, k) => x + h[k])]; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < col.points.length; j++) { const k = j % 3, x = col.points[j] + p[k]; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); }
  return [lo, hi];
}

/** The bungalow, as built or frame only, with its metadata. */
export function bungalow({ frameOnly = false } = {}) {
  const { pack, metadata } = buildVeneerHouse({ storeys: 1 });
  if (!frameOnly) return { pack, metadata };
  const types = pack.scenario.nodeTypes, keep = types.map((t, i) => i);
  const skin = new Set(['brick-veneer', 'veneer-lintel-course', 'drywall', 'ceiling-lining']);
  const kept = keep.filter((i) => !skin.has(types[i]));
  return { pack: withoutSkin(pack), metadata: { ...metadata, nodeWalls: kept.map((i) => metadata.nodeWalls[i]) } };
}

/**
 * The pack with each node `split(i)` names cut along x at the given cuts
 * (pack coordinates, inside the node): sub-boxes of the same material and
 * density, the node's bonds re-hung on the piece(s) under each bond's patch
 * (area shared by the overlap along x), and a bond of the node's own
 * material across each cut (its full section). Cuboid nodes only. Returns
 * {pack, nodeWalls, pieces: Map(old node -> [new nodes])}.
 */
export function rechunk(pack, nodeWalls, split) {
  const p = structuredClone(pack), s = p.scenario, mats = p.defaults.solver.materials, n = s.nodes.length;
  const plans = new Map();
  for (let i = 0; i < n; i++) { const cuts = split(i); if (cuts?.length) plans.set(i, cuts); }
  const out = { nodes: [], nodeSizes: [], nodeColliders: [], nodeTypes: [], nodeMaterials: [], nodePieces: [], nodeGroups: [] }, walls = [], map = new Map(), pieces = new Map(), boxes = [];
  const push = (i, lo, hi) => {
    const size = hi.map((x, k) => x - lo[k]), vol = size[0] * size[1] * size[2], density = mats[s.nodes[i].m].density;
    out.nodes.push({ ...s.nodes[i], centroid: { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 }, mass: s.nodes[i].mass === 0 ? 0 : vol * density, volume: vol });
    out.nodeSizes.push({ x: size[0], y: size[1], z: size[2] }); out.nodeColliders.push({ kind: 'cuboid', halfExtents: { x: size[0] / 2, y: size[1] / 2, z: size[2] / 2 } });
    for (const k of ['nodeTypes', 'nodeMaterials', 'nodePieces', 'nodeGroups']) out[k].push(s[k][i]);
    walls.push(nodeWalls[i]); boxes.push([lo, hi]);
    return out.nodes.length - 1;
  };
  for (let i = 0; i < n; i++) {
    const [lo, hi] = aabb(s, i);
    if (!plans.has(i)) { map.set(i, push(i, lo, hi)); boxes[boxes.length - 1] = null; continue; }
    if (s.nodeColliders[i].kind !== 'cuboid') throw Error(`rechunk: node ${i} is not a box`);
    const xs = [lo[0], ...plans.get(i).filter((x) => x > lo[0] + 1e-6 && x < hi[0] - 1e-6).sort((a, b) => a - b), hi[0]];
    pieces.set(i, xs.slice(0, -1).map((x, k) => push(i, [x, lo[1], lo[2]], [xs[k + 1], hi[1], hi[2]])));
  }
  const bonds = [];
  for (const b of s.bonds) {
    const a = b.node0, c = b.node1;
    if (!pieces.has(a) && !pieces.has(c)) { bonds.push({ ...b, node0: map.get(a), node1: map.get(c) }); continue; }
    // The bond's patch along x: the overlap of the two nodes' bounds.
    const [la, ha] = aabb(s, a), [lc, hc] = aabb(s, c), x0 = Math.max(la[0], lc[0]), x1 = Math.min(ha[0], hc[0]);
    const split = pieces.has(a) ? a : c, other = split === a ? c : a;
    const cands = pieces.get(split).map((q) => ({ q, lo: out.nodes[q].centroid.x - out.nodeSizes[q].x / 2, hi: out.nodes[q].centroid.x + out.nodeSizes[q].x / 2 }));
    const target = (pieces.has(other) ? pieces.get(other) : [map.get(other)]);
    if (x1 - x0 < 1e-4 || Math.abs(b.normal.x) > 0.5) {
      // A patch narrow along x, or facing along x: the piece containing its centroid.
      const at = cands.find((q) => b.centroid.x >= q.lo - 1e-6 && b.centroid.x <= q.hi + 1e-6) ?? cands.reduce((m, q) => (Math.abs((q.lo + q.hi) / 2 - b.centroid.x) < Math.abs((m.lo + m.hi) / 2 - b.centroid.x) ? q : m));
      const t = target.length === 1 ? target[0] : target.find((q) => Math.abs(out.nodes[q].centroid.x - b.centroid.x) <= out.nodeSizes[q].x / 2 + 1e-6) ?? target[0];
      bonds.push({ ...b, node0: split === a ? at.q : t, node1: split === a ? t : at.q });
      continue;
    }
    for (const q of cands) {
      const u0 = Math.max(x0, q.lo), u1 = Math.min(x1, q.hi);
      if (u1 - u0 < 1e-4) continue;
      const t = target.length === 1 ? target[0] : target.find((r) => Math.abs(out.nodes[r].centroid.x - (u0 + u1) / 2) <= out.nodeSizes[r].x / 2 + 1e-6) ?? target[0];
      bonds.push({ ...b, node0: split === a ? q.q : t, node1: split === a ? t : q.q, area: b.area * (u1 - u0) / (x1 - x0), centroid: { ...b.centroid, x: (u0 + u1) / 2 } });
    }
  }
  // The member's own material across each cut (what a bond within one piece of the kit gets).
  for (const [i, list] of pieces) {
    const own = s.bonds.find((b) => (b.node0 === i || b.node1 === i) && s.nodePieces[b.node0] === s.nodePieces[b.node1])?.m ?? s.nodes[i].m;
    for (let k = 0; k < list.length - 1; k++) {
      const a = list[k], c = list[k + 1], x = out.nodes[a].centroid.x + out.nodeSizes[a].x / 2;
      bonds.push({ node0: a, node1: c, centroid: { x, y: out.nodes[a].centroid.y, z: out.nodes[a].centroid.z }, normal: { x: 1, y: 0, z: 0 }, area: out.nodeSizes[a].y * out.nodeSizes[a].z, m: own });
    }
  }
  const shapeLibrary = s.shapeLibrary;
  p.scenario = { ...out, bonds, ...(shapeLibrary && { shapeLibrary }) };
  // Hull colliders keep their library references (unchanged nodes).
  for (let i = 0; i < n; i++) if (!plans.has(i)) p.scenario.nodeColliders[map.get(i)] = s.nodeColliders[i];
  // Unchanged nodes keep their original centroid (a hull's reference point).
  for (let i = 0; i < n; i++) if (!plans.has(i)) p.scenario.nodes[map.get(i)] = { ...s.nodes[i] };
  return { pack: p, nodeWalls: walls, pieces, map };
}

/** The front wall's studs (full-height studs, king and junction studs) by their centre x. */
export function frontStuds(pack, nodeWalls, wall = 'front') {
  const s = pack.scenario, out = new Map();
  for (let i = 0; i < s.nodes.length; i++) {
    if (nodeWalls[i] !== wall || !STUDS.has(s.nodeTypes[i])) continue;
    const [lo, hi] = aabb(s, i), x = +((lo[0] + hi[0]) / 2).toFixed(3);
    const e = out.get(x) ?? { x, type: s.nodeTypes[i], nodes: [], y0: Infinity, y1: -Infinity };
    e.nodes.push(i); e.y0 = Math.min(e.y0, lo[1]); e.y1 = Math.max(e.y1, hi[1]);
    out.set(x, e);
  }
  return [...out.values()].sort((a, b) => a.x - b.x);
}

/** C24 (EN 338) top plate, 90 x 90 (the doubled 2 / 90 x 45 as one member, as the kit builds it). */
export const PLATE = { b: 0.09, h: 0.09, E: 11e9, fm: 24e6, fv: 4.0e6, longTerm: 0.6 };

/**
 * The front wall's vertical loads on its top plate, from the pack's own
 * masses: each rafter line (its rafters, the roof covering strips over it and
 * its share of the ridge board) puts half its weight on each eaves plate (a
 * tied couple roof, symmetric); each ceiling joist spans eaves plate to centre
 * wall and puts half its weight (and, as built, half the ceiling lining it
 * carries) on the eaves plate. Point loads [{x, P}] in N.
 */
export function plateLoads(pack) {
  const s = pack.scenario, line = new Map(), roof = new Set(['rafter', 'roof-covering', 'ridge-board']);
  const lines = [...new Set(s.nodes.map((_, i) => i).filter((i) => s.nodeTypes[i] === 'rafter').map((i) => { const [lo, hi] = aabb(s, i); return +((lo[0] + hi[0]) / 2).toFixed(3); }))].sort((a, b) => a - b);
  const nearest = (x, xs) => xs.reduce((m, v) => (Math.abs(v - x) < Math.abs(m - x) ? v : m));
  for (let i = 0; i < s.nodes.length; i++) {
    if (!roof.has(s.nodeTypes[i])) continue;
    const [lo, hi] = aabb(s, i), w = s.nodes[i].mass * G;
    if (s.nodeTypes[i] === 'ridge-board') { for (const x of lines) if (x >= lo[0] && x <= hi[0]) line.set(x, (line.get(x) ?? 0) + w / lines.filter((y) => y >= lo[0] && y <= hi[0]).length); continue; }
    const x = nearest((lo[0] + hi[0]) / 2, lines);
    line.set(x, (line.get(x) ?? 0) + w);
  }
  const loads = [...line].map(([x, W]) => ({ x, P: W / 2, what: 'rafter seat' }));
  // Ceiling joists (front half, z < 0) and the lining under them.
  const joists = new Map();
  for (let i = 0; i < s.nodes.length; i++) {
    if (s.nodeTypes[i] !== 'ceiling-joist') continue;
    const [lo, hi] = aabb(s, i);
    if (hi[2] > 0.01) continue;
    joists.set(+((lo[0] + hi[0]) / 2).toFixed(3), s.nodes[i].mass * G);
  }
  const jx = [...joists.keys()].sort((a, b) => a - b);
  for (let i = 0; i < s.nodes.length; i++) {
    if (s.nodeTypes[i] !== 'ceiling-lining' || !jx.length) continue;
    const [lo, hi] = aabb(s, i);
    if (hi[2] > 0.01) continue;
    const under = jx.filter((x) => x >= lo[0] - 0.05 && x <= hi[0] + 0.05);
    for (const x of under) joists.set(x, joists.get(x) + s.nodes[i].mass * G / under.length);
  }
  for (const [x, W] of joists) loads.push({ x, P: W / 2, what: 'ceiling joist' });
  return loads.sort((a, b) => a.x - b.x);
}

/**
 * The front top plate as a continuous C24 beam over the studs that remain
 * (pinned: two end nails), over the opening headers (built up solid to the
 * plate and lapped to it: a support every 0.3 m), with the plate's point
 * loads and self-weight; or, as authored, rigid between its chunk seams
 * (`seams`: the x of each cut where the stage checks it). Returns per check
 * point x: M, V and the utilisation against C24's sustained (elastic) limit
 * and its short-term (fatal) one, as the stage reads a 90 x 90 bond.
 */
export function plateCheck(pack, nodeWalls, removedX, { seams = null, step = 0.05 } = {}) {
  const s = pack.scenario, studs = frontStuds(pack, nodeWalls).filter((e) => e.y1 > 2.5 && !removedX.some((x) => Math.abs(x - e.x) < 1e-3));
  const plates = s.nodes.map((_, i) => i).filter((i) => nodeWalls[i] === 'front' && s.nodeTypes[i] === 'top-plate').map((i) => aabb(s, i)).sort((a, b) => a[0][0] - b[0][0]);
  const x0 = +plates[0][0][0].toFixed(3), x1 = +plates.at(-1)[1][0].toFixed(3);
  const headers = s.nodes.map((_, i) => i).filter((i) => nodeWalls[i] === 'front' && s.nodeTypes[i] === 'header').map((i) => aabb(s, i));
  const jacks = frontStuds(pack, nodeWalls).filter((e) => e.type === 'jack-stud');
  const supports = new Set(studs.map((e) => e.x));
  const loads = plateLoads(pack).filter((l) => l.x >= x0 && l.x <= x1);
  const pts = new Set([x0, x1, ...supports, ...loads.map((l) => l.x)]);
  for (let x = x0; x <= x1; x += step) pts.add(+x.toFixed(3));
  if (seams) for (const x of seams) pts.add(+x.toFixed(3));
  const xs = [...new Set([...pts].map((x) => +x.toFixed(3)))].filter((x) => x >= +x0.toFixed(3) && x <= +x1.toFixed(3)).sort((a, b) => a - b);
  const f = frame(), node = new Map(xs.map((x) => [x, f.node(x, 0)]));
  const A = PLATE.b * PLATE.h, I = PLATE.b * PLATE.h ** 3 / 12, S = PLATE.b * PLATE.h ** 2 / 6, w = A * 420 * G;
  // As authored the plate is rigid within a chunk: a member stiffer by 1e4 except across a seam.
  const rigid = (a, b) => seams && !seams.some((x) => x > a + 1e-9 && x < b - 1e-9) && !seams.some((x) => Math.abs(x - a) < 1e-9 || Math.abs(x - b) < 1e-9);
  const members = [];
  for (let k = 0; k < xs.length - 1; k++) members.push({ a: xs[k], b: xs[k + 1], m: f.member(node.get(xs[k]), node.get(xs[k + 1]), { E: PLATE.E * (rigid(xs[k], xs[k + 1]) ? 1e4 : 1), A, I, w }) });
  for (const x of supports) if (node.has(x)) f.fix(node.get(x), 'y');
  f.fix(node.get(xs[0]), 'x');
  for (const l of loads) f.load(node.get(l.x), 0, -l.P, 0);
  // Each opening's header (2 / 190 x 45 on edge, built up solid to the plate, lapped to it) under
  // the plate: a C24 beam on its jack studs, joined to the plate wherever they share a node.
  for (const [lo, hi] of headers) {
    const hh = hi[1] - lo[1], y = -(PLATE.h / 2 + hh / 2), Ah = 0.09 * hh, Ih = 0.09 * hh ** 3 / 12;
    const hx = xs.filter((x) => x >= lo[0] - 1e-9 && x <= hi[0] + 1e-9);
    const hn = new Map(hx.map((x) => [x, f.node(x, y)]));
    for (let k = 0; k < hx.length - 1; k++) f.member(hn.get(hx[k]), hn.get(hx[k + 1]), { E: PLATE.E, A: Ah, I: Ih, w: Ah * 420 * G });
    for (const x of hx) f.member(node.get(x), hn.get(x), { E: PLATE.E, A: 1, I: 1e-2, w: 0 });
    for (const j of jacks) if (j.x >= lo[0] - 0.05 && j.x <= hi[0] + 0.05) { const x = hx.reduce((m, v) => (Math.abs(v - j.x) < Math.abs(m - j.x) ? v : m)); f.fix(hn.get(x), 'y'); }
  }
  const r = f.solve();
  const at = (x) => { const e = members.find((m) => x >= m.a - 1e-9 && x <= m.b + 1e-9); return r.at(e.m, x - e.a); };
  const where = seams ?? xs;
  const out = where.map((x) => {
    const { M, V } = at(x), sigma = Math.abs(M) / S, tau = Math.abs(V) / A;
    return { x: +x.toFixed(3), M, V, u: Math.max(sigma / (PLATE.longTerm * PLATE.fm), tau / (PLATE.longTerm * PLATE.fv)), uFatal: Math.max(sigma / PLATE.fm, tau / PLATE.fv) };
  });
  // The studs either side of the gap: the stud-plate joint's bearing (f_c,90,k 2.5 MPa x 90 x 45 mm, sustained 0.6).
  const reactions = studs.map((e) => ({ x: e.x, R: r.reactions.get(node.get(e.x))?.[1] ?? 0 }));
  const bearing = reactions.map((q) => ({ ...q, u: q.R / (0.6 * 2.5e6 * 0.09 * 0.045) }));
  return { checks: out, worst: out.reduce((a, b) => (b.u > a.u ? b : a)), bearing: bearing.reduce((a, b) => (b.u > a.u ? b : a)), loads, line: loads.reduce((t, l) => t + l.P, 0) / (x1 - x0) };
}

/**
 * The hand calculation an engineer would do: the front top plate over the
 * plain run between the partition junction stud and the door's king stud, a
 * continuous C24 90 x 90 beam on the studs that remain, its two ends either
 * pinned or clamped (the plate runs on over a junction and a built-up header:
 * the truth lies between, so both bound the answer), loaded by the rafter
 * seats and joist ends over it and its own weight. Per removal: the worst
 * bending/shear utilisation of the plate (sustained and short-term limits) and
 * each remaining stud's reaction and its stud-plate joint's bearing (f_c,90,k
 * 2.5 MPa on 90 x 45; reported, not a collapse mode -- see the write-up).
 */
export function plateSpan(pack, nodeWalls, removedX, { ends = 'pinned', from = -1.8, to = 1.532, step = 0.025 } = {}) {
  const studs = frontStuds(pack, nodeWalls).filter((e) => e.y1 > 2.5 && e.x >= from - 1e-3 && e.x <= to + 1e-3 && !removedX.some((x) => Math.abs(x - e.x) < 1e-3));
  const loads = plateLoads(pack).filter((l) => l.x > from && l.x < to);
  const pts = new Set([from, to, ...studs.map((e) => e.x), ...loads.map((l) => l.x)]);
  for (let x = from; x <= to; x += step) pts.add(+x.toFixed(3));
  const xs = [...new Set([...pts].map((x) => +x.toFixed(3)))].sort((a, b) => a - b);
  const f = frame(), node = new Map(xs.map((x) => [x, f.node(x, 0)]));
  const A = PLATE.b * PLATE.h, I = PLATE.b * PLATE.h ** 3 / 12, S = PLATE.b * PLATE.h ** 2 / 6, w = A * 420 * G;
  const members = [];
  for (let k = 0; k < xs.length - 1; k++) members.push({ a: xs[k], m: f.member(node.get(xs[k]), node.get(xs[k + 1]), { E: PLATE.E, A, I, w }) });
  for (const e of studs) f.fix(node.get(+e.x.toFixed(3)), 'y');
  f.fix(node.get(xs[0]), ends === 'fixed' ? 'xyz' : 'xy');
  f.fix(node.get(xs.at(-1)), ends === 'fixed' ? 'xyz' : 'y');
  for (const l of loads) f.load(node.get(+l.x.toFixed(3)), 0, -l.P, 0);
  const r = f.solve();
  const checks = members.map((mm, k) => { const { M, V } = r.at(mm.m, 0); const sigma = Math.abs(M) / S, tau = Math.abs(V) / A;
    return { x: xs[k], M, V, u: Math.max(sigma / (PLATE.longTerm * PLATE.fm), tau / (PLATE.longTerm * PLATE.fv)), uFatal: Math.max(sigma / PLATE.fm, tau / PLATE.fv) }; });
  const R = studs.map((e) => ({ x: e.x, R: r.reactions.get(node.get(+e.x.toFixed(3)))?.[1] ?? 0 })).map((q) => ({ ...q, bearing: q.R / (2.5e6 * 0.09 * 0.045) }));
  const worst = checks.reduce((a, b) => (b.u > a.u ? b : a));
  const gaps = studs.map((e) => e.x).sort((a, b) => a - b).slice(1).map((x, k, arr) => x - (k ? arr[k - 1] : studs.map((e) => e.x).sort((a, b) => a - b)[0]));
  return { worst, checks, reactions: R, maxBearing: R.reduce((a, b) => (b.bearing > a.bearing ? b : a)), gap: Math.max(...gaps) };
}

/**
 * Where to cut the front top plate so the stage checks its bending where the
 * hand calculation peaks: just either side of every full-height stud (the
 * hogging over a support, 35 mm off the stud's face) and midway between
 * neighbouring studs (the sagging between them), each mid cut moved clear of
 * the rafter seats and joist ends (a point load on a cut would be split
 * between two pieces). Pieces of 0.1 m or more; not across the kit's own
 * seams, which already are bonds.
 */
export function plateCuts(pack, nodeWalls, { side = 0.0575, clearance = 0.04 } = {}) {
  const s = pack.scenario, plates = s.nodes.map((_, i) => i).filter((i) => nodeWalls[i] === 'front' && s.nodeTypes[i] === 'top-plate');
  const bounds = plates.map((i) => aabb(s, i)), lo = Math.min(...bounds.map((b) => b[0][0])), hi = Math.max(...bounds.map((b) => b[1][0]));
  const seams = bounds.map((b) => b[1][0]).filter((x) => x < hi - 1e-6);
  const studs = frontStuds(pack, nodeWalls).filter((e) => e.y1 > 2.5).map((e) => e.x);
  const loads = plateLoads(pack).map((l) => l.x);
  const busy = (c) => loads.some((x) => Math.abs(x - c) < 0.0225 + clearance) || studs.some((x) => Math.abs(x - c) < 0.0225 + 0.01);
  const want = [];
  for (const x of studs) want.push(x - side, x + side);
  for (let k = 0; k < studs.length - 1; k++) {
    let c = (studs[k] + studs[k + 1]) / 2, d = 0;
    while (busy(c) && d < 0.3) { d += 0.01; c = busy(c + d) ? c - d : c + d; if (!busy(c)) break; }
    if (!busy(c)) want.push(c);
  }
  const cuts = [];
  for (const c of want.filter((x) => x > lo + 0.1 && x < hi - 0.1 && !seams.some((q) => Math.abs(q - x) < 0.1)).sort((a, b) => a - b)) {
    if (cuts.length && c - cuts.at(-1) < 0.1) continue;
    cuts.push(+c.toFixed(3));
  }
  return { cuts, plates };
}
