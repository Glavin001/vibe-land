#!/usr/bin/env node
// The scenario-outcome matrix: what each impactor does to each target in the
// real world (scripts/verify/scenarios.json, derived by scenario-physics.mjs
// from the scene's geometry and cited strengths), judged against the test bed's
// runs. docs/verification/SCENARIOS.md is the matrix with its derivations.
//
//   node scripts/verify/scenarios.mjs table [--lab PACK] [--town PACK]         the expectations
//   node scripts/verify/scenarios.mjs trials lab|town|fleet                    the harness case ids
//   node scripts/verify/scenarios.mjs meta lab|town --pack PACK --base META --out FILE
//   node scripts/verify/scenarios.mjs judge PROFILE [--lab PACK] [--town PACK] [--out FILE] report.json...
//
// Every bound is derived:
//   outcome   through / stopped from NDRC + Recht-Ipson over the path's layers
//             (shots), or EN 1991-1-7 Annex C's force against the wall's
//             resistance (vehicles); "either" where the source's scatter (NDRC
//             perforation +-20-25%, the resistance range) spans both, and then
//             the scenario's `intent` chooses.
//   exit      the speed after the struck layer(s) within [the engine's chunk
//             plug at the nominal strengths, the real swept plug at the weak end],
//             +-10% of the speed in for the tick sampling (as acceptance.mjs).
//   local     no broken bond farther from the line of travel than r + 2t + l:
//             the impactor's radius (a car: its half-width), the punching
//             perimeter 2t past it (EN 1992-1-1 6.4.2), and the longest member
//             with a joint inside that perimeter (it can break its own far joints).
//   stands    no roof member down more than 0.5 m (the house probe's own definition).
//   more      a meteor breaks more of a target than a cannonball (swept area x8.5).
//   vehicle   every part the projectile passed through (to its mid-plane) is
//             off, and everything held on only through them; wheels kept and
//             drives (>= 3 m in 3 s, criteria.mjs) where nothing cut the car.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { throughLayers, vehicleImpactForce, reducedMass, timberBendingWork, sphereDiameter, MATERIAL, NOSE, ndrc } from './scenario-physics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '../..');
export const DATA = JSON.parse(readFileSync(path.join(here, 'scenarios.json'), 'utf8'));
const EXIT_TOL = 0.1, ROOF_DOWN = 0;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const packs = {};
const pack = (scene) => {
  const p = scene === 'town' ? arg('--town', path.join(ROOT, 'structures/vibe-town/out/vibe-town.json')) : arg('--lab', path.join(ROOT, 'structures/vehicle-lab/out/vehicle-lab.json'));
  return (packs[scene] ??= existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
};

/** The impactor with its diameter and frontal area. */
export function impactor(id, speed) {
  const I = DATA.impactors[id];
  if (!I) throw new Error(`no impactor ${id}`);
  const diameter = I.radius ? 2 * I.radius : I.density ? sphereDiameter(I.mass, I.density) : 2 * Math.sqrt((I.front[0] * I.front[1]) / Math.PI);
  return { ...I, id, speed: speed ?? I.speed, diameter, radius: diameter / 2, nose: NOSE[I.nose ?? 'sphere'], carries: !!I.vehicle,
    frontalArea: I.front ? I.front[0] * I.front[1] : Math.PI * diameter * diameter / 4 };
}

/** The harness case: its line of travel (aim point, unit direction), struck group, layer and chunk. */
async function caseOf(id, scene) {
  const { matrix, townMatrix } = await import('../../structures/vehicle-lab/wall-matrix.mjs');
  const { TRIALS, LANES } = await import('../../structures/vehicle-lab/trials.mjs');
  const P = pack(scene);
  if (id.startsWith('wm-')) {
    const t = (scene === 'town' ? townMatrix(P) : matrix(P, 'all')).find((x) => x.id === id);
    if (!t) return null;
    const from = t.attack?.from ?? ((Number(t.at.split(',')[2]) + 180) % 360);
    const b = (from * Math.PI) / 180;
    return { trial: t, aim: t.target, dir: [-Math.sin(b), 0, -Math.cos(b)], group: t.matrix.group, layer: t.layer, chunk: t.matrix.chunk };
  }
  const t = TRIALS.find((x) => x.id === id);
  if (!t) return null;
  if (t.attack?.kind === 'shot') {
    const b = (t.attack.from * Math.PI) / 180;
    return { trial: t, aim: t.attack.target, dir: [-Math.sin(b), 0, -Math.cos(b)], group: 'framed-house', layer: 0.3 };
  }
  if (t.at.startsWith('lane/')) {
    const lane = LANES.find((l) => `lane/${l.id}` === t.at);
    const group = t.struck ?? (lane.obstacle.kind === 'framed-house' ? 'framed-house' : lane.obstacle.kind === 'wall' ? 'wall' : null);
    return { trial: t, aim: [lane.x + (t.dx ?? 0), 0, lane.obstacle.z - (lane.obstacle.kind === 'wall' ? 0.125 : 3.9)], dir: [0, 0, 1], group, layer: lane.obstacle.thickness ?? 0.3 };
  }
  return { trial: t };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const MASONRY = /brick|mortar|stone|concrete|kerb|footing|plinth|slate|tile|ramp|masonry/;
const TIMBER = /timber|stud|joist|rafter|plate|frame|oak|wood|joinery|board|gable|batten|weatherboard|particleboard|trunk|branch/;
/**
 * The layers a prism of half-extents (hu, hw) across the line meets over
 * `length` m of it: nodes of `group` whose boxes overlap it, merged by depth.
 * Each layer: its depth, thickness, the real swept mass (each chunk's mass x
 * its overlapped share) and the engine's plug (whole chunks), and its material
 * class. Projections are AABB support functions (exact for the axis-aligned
 * lines the matrix uses).
 */
export function pathLayers(P, group, aim, dir, hu, hw, length) {
  const s = P.scenario;
  const up = Math.abs(dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
  const un = Math.hypot(...u); u.forEach((x, i) => { u[i] = x / un; });
  const w = [dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]];
  const hits = [];
  for (let i = 0; i < s.nodes.length; i += 1) {
    if (!(s.nodes[i].mass > 0) || !s.nodeGroups[i].startsWith(group)) continue;
    const c = s.nodes[i].centroid, z = s.nodeSizes[i], cc = [c.x - aim[0], c.y - aim[1], c.z - aim[2]], h = [z.x / 2, z.y / 2, z.z / 2];
    const ext = (a) => Math.abs(a[0]) * h[0] + Math.abs(a[1]) * h[1] + Math.abs(a[2]) * h[2];
    const span = (a, lo, hi) => { const m = dot(cc, a), e = ext(a); return [Math.max(lo, m - e), Math.min(hi, m + e), 2 * e]; };
    const [d0, d1, dd] = span(dir, 0, length), [u0, u1, du] = span(u, -hu, hu), [w0, w1, dw] = span(w, -hw, hw);
    if (d1 <= d0 || u1 <= u0 || w1 <= w0) continue;
    const share = ((d1 - d0) / dd) * ((u1 - u0) / du) * ((w1 - w0) / dw);
    const mat = s.nodeMaterials?.[i] ?? '', type = s.nodeTypes?.[i] ?? '';
    const kind = MASONRY.test(mat) ? (/stone/.test(mat) ? 'stone' : /concrete|footing|kerb|ramp/.test(mat) ? 'concrete' : 'brick') : TIMBER.test(mat) || TIMBER.test(type) ? 'timber' : 'other';
    const dims = [z.x, z.y, z.z].sort((a, b) => a - b);
    // Across the path (a wall, a pane, a post): thinner along it than across
    // it. A member lying along the path (a floor, a joist, a side wall) is
    // swept, not perforated: its mass and bending count, its depth does not.
    const across = dd <= Math.max(du, dw);
    hits.push({ i, d0, d1, across, mass: s.nodes[i].mass * share, chunkMass: s.nodes[i].mass, kind, dims, name: `${type}/${mat}` });
  }
  hits.sort((a, b) => a.d0 - b.d0);
  const layers = [];
  for (const n of hits.filter((x) => x.across)) {
    const L = layers[layers.length - 1];
    if (L && n.d0 < L.d1 - 1e-3) { L.d1 = Math.max(L.d1, n.d1); L.nodes.push(n); } else layers.push({ d0: n.d0, d1: n.d1, nodes: [n] });
  }
  for (const n of hits.filter((x) => !x.across)) {
    const mid = (n.d0 + n.d1) / 2;
    const L = layers.find((x) => mid >= x.d0 && mid <= x.d1) ?? layers.filter((x) => x.d0 <= mid).pop();
    if (L) L.along = [...(L.along ?? []), n]; else layers.unshift({ d0: n.d0, d1: n.d0, nodes: [], along: [n] });
  }
  return layers.map((L) => {
    const alongMass = (L.along ?? []).reduce((a, n) => a + n.mass, 0);
    L.nodes = [...L.nodes, ...(L.along ?? []).map((n) => ({ ...n, kind: n.kind === 'timber' ? 'timber' : 'other' }))];
    const m = (k) => L.nodes.filter((n) => n.kind === k).reduce((a, n) => a + n.mass, 0);
    const mass = L.nodes.reduce((a, n) => a + n.mass, 0), chunkMass = L.nodes.reduce((a, n) => a + n.chunkMass, 0);
    const kind = ['brick', 'stone', 'concrete', 'timber', 'other'].sort((a, b) => m(b) - m(a))[0];
    // Timber: the work to break each member it crosses in bending (EN 338 C24 mean).
    const work = L.nodes.filter((n) => n.kind === 'timber').reduce((a, n) => a + timberBendingWork(n.dims[0], n.dims[1], Math.max(n.dims[2], 0.3)).work, 0);
    return { d0: L.d0, thickness: L.d1 - L.d0, mass, alongMass, chunkMass, kind, work, names: [...new Set(L.nodes.map((n) => n.name))].slice(0, 4) };
  });
}

const FC = { brick: MATERIAL.brickMasonry.fc, stone: MATERIAL.stoneMasonry.fc, concrete: MATERIAL.concrete.fc };
/** Speed after the layers, with each brittle layer's NDRC limit (thickness x `scale`) and the plug `plug(L)`. */
function exitThrough(I, layers, scale, plug, resistance) {
  // A car is not a rigid penetrator: it pushes a layer through at the layer's
  // resistance (the target's range, EN 1996 / EN 1995 above) over its depth.
  return throughLayers(I, layers.map((L) => ({ name: L.kind, thickness: L.thickness * scale, plugKg: plug(L), density: 0,
    ...(I.vehicle ? { work: (resistance ?? 0) * L.thickness * scale + L.work * scale } : FC[L.kind] ? { fc: FC[L.kind] } : { work: L.work * scale }) })));
}

/** The real-world expectation of one scenario (and the case it is played by). */
export async function expectation(sc) {
  const scene = sc.scene ?? 'lab';
  const I = impactor(sc.impactor, sc.impactorSpeed);
  const c = await caseOf(sc.case, scene);
  const out = { id: sc.id, impactor: I, case: c, scene, expect: sc.expect, intent: sc.intent, why: sc.why, pathLength: sc.pathLength };
  if (!c) return { ...out, error: `no case ${sc.case}` };
  const P = pack(scene);
  if (c.group && P) {
    const length = sc.pathLength ?? c.layer + (I.vehicle ? 0 : I.radius);
    const [hu, hw] = I.front ? [I.front[0] / 2, I.front[1] / 2] : [I.radius * Math.sqrt(Math.PI) / 2, I.radius * Math.sqrt(Math.PI) / 2];
    // A car's line runs at half its front's height above the ground under the aim.
    const aim = I.front ? [c.aim[0], I.front[1] / 2, c.aim[2]] : c.aim;
    // A steep shot (the roof, slope >= 0.5) is followed along its real line.
    const slope = c.trial?.attack?.slope ?? 0;
    const dir = slope >= 0.5 ? (() => { const v = [c.dir[0], -slope, c.dir[2]], n = Math.hypot(...v); return v.map((x) => x / n); })() : c.dir;
    const layers = pathLayers(P, c.group, aim, dir, hu, hw, length);
    out.layers = layers;
    const R = DATA.targets[sc.target]?.resistanceN ?? [0, 0];
    const nominal = exitThrough(I, layers, 1, (L) => L.mass, (R[0] + R[1]) / 2);
    // The weak end: members lying along the path pushed aside, not carried.
    const weak = exitThrough(I, layers, 0.8, (L) => L.mass - L.alongMass, R[0]), strong = exitThrough(I, layers, 1.25, (L) => L.mass, R[1]);
    const chunky = exitThrough(I, layers, 1, (L) => L.chunkMass, R[1]);
    out.exit = { nominal: nominal.exitSpeed, low: Math.min(chunky.exitSpeed, strong.exitSpeed), high: weak.exitSpeed, perLayer: nominal.layers };
    if (I.vehicle) {
      const T = DATA.targets[sc.target];
      const F = vehicleImpactForce(I.mass, I.speed).force;
      out.force = { F, resistance: T?.resistanceN, why: T?.resistanceWhy };
      out.outcome = !T ? (nominal.through ? 'through' : 'stopped') : F > T.resistanceN[1] ? 'through' : F < T.resistanceN[0] ? 'stopped' : 'either';
    } else {
      out.outcome = weak.through && strong.through ? 'through' : !weak.through && !strong.through ? 'stopped' : 'either';
    }
    // Locality (docs/verification/SCENARIOS.md, "Local"): the reach of the hit
    // from its line is the punching perimeter, r + 2t (EN 1992-1-1 6.4.2: the
    // basic control perimeter lies 2d from the loaded area), plus the longest
    // member with a joint inside it (a member cut or hinged there can break its
    // own other joints, up to its length away).
    const struck = layers[0];
    const r = I.front ? I.front[0] / 2 : I.radius, t = struck?.thickness ?? c.layer ?? 0.3, perimeter = r + 2 * t;
    let member = 0;
    for (let i = 0; i < P.scenario.nodes.length; i += 1) {
      if (!P.scenario.nodeGroups[i].startsWith(c.group) || !(P.scenario.nodes[i].mass > 0)) continue;
      const q = P.scenario.nodes[i].centroid, sz = P.scenario.nodeSizes[i];
      const rel = [q.x - aim[0], q.y - aim[1], q.z - aim[2]], along = rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2];
      const perp = Math.hypot(rel[0] - along * dir[0], rel[1] - along * dir[1], rel[2] - along * dir[2]);
      const half = 0.5 * Math.hypot(sz.x, sz.y, sz.z);
      if (perp - half <= perimeter && along + half >= -r && along - half <= t + r) member = Math.max(member, sz.x, sz.y, sz.z);
    }
    out.local = { r, t, perimeter, member, reach: perimeter + member };
    // A free-standing unreinforced masonry panel (targets[].locality 'panel', SCENARIOS.md
    // "Local"): its yield lines end only on its supports and free edges, so the reach is the
    // struck panel itself -- its farthest point from the line.
    const T = DATA.targets[c.trial?.matrix?.target ?? sc.target];
    if (T?.locality === 'panel') {
      let panel = 0;
      for (let i = 0; i < P.scenario.nodes.length; i += 1) {
        if (!P.scenario.nodeGroups[i].startsWith(c.group) || !(P.scenario.nodes[i].mass > 0)) continue;
        const q = P.scenario.nodes[i].centroid, sz = P.scenario.nodeSizes[i];
        const rel = [q.x - aim[0], q.y - aim[1], q.z - aim[2]], along = rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2];
        panel = Math.max(panel, Math.hypot(rel[0] - along * dir[0], rel[1] - along * dir[1], rel[2] - along * dir[2]) + 0.5 * Math.hypot(sz.x, sz.y, sz.z));
      }
      out.local = { ...out.local, kind: 'panel', punching: out.local.reach, reach: panel };
    }
  }
  if (sc.expect?.outcome === 'either' || (out.outcome === 'either' && sc.intent)) out.outcome = sc.intent ? sc.intent.split(':')[0] : 'either';
  if (!out.outcome) out.outcome = sc.expect?.outcome;
  return out;
}

// ------------------------------------------------------------------ judge ---
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
function judgeOne(ex, run, others) {
  const rows = [];
  const row = (check, expected, measured, pass, note) => rows.push({ scenario: ex.id, check, expected, measured, pass: pass === null ? null : !!pass, note });
  const e = ex.expect ?? {};
  if (!run) { row('ran', 'a run', 'missing', false); return rows; }
  if (run.failedSteps) row('every step completed', '0', run.failedSteps, false);
  const pr = run.probe, I = ex.impactor;
  // A shot must meet the structure before anything else: a tick before first
  // contact that cost it more than 0.5% of its KE touched grade or terrain
  // first, and the trial then measures that contact too (mis-aimed).
  if (run.preContact && run.attack?.kind === 'shot')
    row('reaches the structure untouched', 'no loss before first contact', run.preContact.ticks ? `${run.preContact.ticks} ticks, ${f(run.preContact.lossJ / 1e6, 2)} MJ lost first` : 'none', !run.preContact.ticks);
  // Outcome.
  if (e.outcome && e.outcome !== 'either') {
    let through, measured;
    if (ex.case?.trial && run.attack?.kind && !run.probe && run.swept) { /* vehicle target: below */ }
    else if (e.outcome === 'through-front' || ex.case?.trial?.at?.startsWith?.('lane/')) {
      const z = DATA.scenarios.find((s) => s.id === ex.id)?.throughZ ?? ex.throughZ;
      through = run.maxZ >= z; measured = `middle at z ${f(run.maxZ, 2)} (through at ${z})`;
    } else if (pr?.contact) {
      const need = (run.layer ?? 0.3) + (I.vehicle ? 1 : 2 * I.radius);
      through = pr.pastMax > need; measured = `${f(pr.pastMax, 2)} m past the face (through > ${f(need, 2)}), v ${f(pr.vIn)} -> ${f(pr.vOut)} m/s`;
    } else if (pr && !pr.contact) { through = true; measured = 'no contact recorded'; }
    else if (run.attack?.pastTarget != null) { through = run.attack.pastTarget >= (ex.case?.layer ?? 0.3) + 2 * I.radius; measured = `${f(run.attack.pastTarget, 2)} m past`; }
    // A shot whose sphere is below grade at the struck layer meets the ground with
    // the structure (FIDELITY_AUDIT E10): measured, not judged (the owner, 2026-10-08:
    // meteor scenarios are judged from first contact with the structure).
    const atGrade = !I.vehicle && ex.case?.aim && ex.case.aim[1] - I.radius < 0;
    const steep = (ex.case?.trial?.attack?.slope ?? 0) >= 0.5;
    if (steep && pr?.contact) {
      // From above: through = still moving down into the house one roof depth past first contact.
      const row = (pr.window ?? []).find((w) => w.past >= (run.layer ?? 0.5));
      through = !!row && row.v > 0; measured = row ? `${f(row.past, 2)} m past first contact at ${f(row.v)} m/s` : 'never a roof depth past';
    }
    if (through !== undefined) {
      const want = e.outcome === 'stopped' ? false : true;
      if (atGrade) { row('outcome', `${ex.outcome} (at grade: entangled with the ground, E10)`, measured, null); through = undefined; }
    }
    if (through !== undefined) {
      const want = e.outcome === 'stopped' ? false : true;
      const derivation = ex.force?.resistance ? `F ${f(ex.force.F / 1e3, 0)} kN vs ${ex.force.resistance.map((x) => f(x / 1e3, 0)).join('-')} kN` : ex.exit ? `exit ${f(ex.exit.low)}-${f(ex.exit.high)} m/s` : '';
      row('outcome', `${ex.outcome}${derivation ? ` (${derivation})` : ''}${ex.intent ? ' [intent]' : ''}`, measured, through === want);
    }
  }
  // Exit speed.
  // A projectile whose sphere dips below grade meets the rigid ground (FIDELITY_AUDIT E10): its exit is measured only.
  const drop = (ex.case?.trial?.attack?.slope ?? 0) * (ex.pathLength ?? ex.case?.layer ?? 0);
  const belowGrade = !I.vehicle && ex.case?.aim && ex.case.aim[1] - drop - I.radius < 0;
  if (e.exit && ex.exit && pr?.contact) {
    const steep = (ex.case?.trial?.attack?.slope ?? 0) >= 0.5;
    const v = steep ? (pr.window ?? []).find((w) => w.past >= (run.layer ?? 0.5))?.v
      : ex.pathLength ? (pr.vAtPast ?? []).find((x) => x[0] >= ex.pathLength)?.[1] : pr.vExit;
    const lo = Math.max(0, ex.exit.low - EXIT_TOL * I.speed), hi = ex.exit.high + EXIT_TOL * I.speed;
    row('exit speed (m/s)', `${f(ex.exit.nominal)} [${f(lo)}-${f(hi)}] (Recht-Ipson over ${ex.layers.length} layers)${belowGrade ? ' (below grade: E10, measured)' : ''}`, v == null ? 'never past' : f(v), belowGrade ? null : v != null && v >= lo && v <= hi);
  }
  // Locality.
  const h = run.house;
  if (e.local && h?.lineDistances && ex.local) {
    // Stopgap (SCENARIOS.md "Local"): judged on the breaks during the impactor's
    // passage; those after it (debris, aftermath) are reported apart.
    const far = ex.local.reach, during = h.lineDistancesDuring ?? h.lineDistances, after = h.lineDistancesAfter ?? [];
    const beyond = during.filter((d) => d > far).length, beyondAfter = after.filter((d) => d > far).length;
    if (ex.local.kind === 'panel')
      row('damage local (bonds broken beyond the struck panel from the line, during the passage: yield lines end at its supports and free edges)', `0 beyond ${f(far, 2)} m (the panel; punching reach r + 2t + member ${f(ex.local.punching, 2)})`, `${beyond} of ${during.length}`, e.local === 'reported' ? null : beyond === 0);
    else row('damage local (bonds broken beyond r + 2t + member from the line, during the passage)', `0 beyond ${f(far, 2)} m (r ${f(ex.local.r, 2)} + 2t ${f(2 * ex.local.t, 2)} + member ${f(ex.local.member, 2)})`, `${beyond} of ${during.length}`, e.local === 'reported' ? null : beyond === 0);
    if (h.lineDistancesAfter) row('bonds broken beyond that reach after the passage (debris, aftermath: reported)', 'reported', `${beyondAfter} of ${after.length}`, null);
  }
  if (e.stands && h?.roofMembers) row('stands (roof members down > 0.5 m)', `${ROOF_DOWN}`, `${h.roofMembersDown} of ${h.roofMembers}`, e.stands === 'reported' ? null : h.roofMembersDown <= ROOF_DOWN);
  // A landing (expect.rebound): the meteor meets grade, and may leave it upward at no more
  // than the contact's restitution of its descent, e v_n (the world's e 0.1; Hibbeler,
  // Dynamics, 15.4: a rigid floor). Faster is energy the contact made: a late contact pushed
  // out, or a kinematic edge's ramp (physx-bridge/tests/infinite_wall.rs meteor_rebound_off_ground).
  if (e.rebound && pr) {
    const vn = Math.max(0, -(pr.impactorUpIn ?? 0)), bound = e.rebound * vn;
    row('rebound off the ground (m/s up, at most e v_n + 1)', `<= ${f(bound, 2)} (e ${e.rebound} x v_n ${f(vn, 2)})`, f(pr.impactorUpMax, 2), (pr.impactorUpMax ?? 0) <= bound + 1.0);
  }
  if (e.broken) {
    const n = h?.broken ?? Object.values(run.sceneBroken ?? {}).reduce((a, b) => a + b, 0);
    row('struck target breaks', '>= 1 bond', n, n >= 1);
  }
  if (e.more) {
    // More, or all of it (a meteor that breaks every bond of a garden wall cannot break more).
    const o = others(e.more), a = h?.broken ?? 0, b = o?.house?.broken;
    row(`more than ${e.more}`, `> its ${b ?? '?'} bonds (or equal: the whole struck piece either way) (swept area x${f((I.radius / 0.687) ** 2)})`, a, b != null && a >= b);
  }
  // Vehicles.
  const V = e.vehicle;
  if (V) {
    const sw = run.swept;
    // Cut parts (its diameter spans them) come off; wider ones it passed into are holed (reported).
    const cutN = sw?.cut ?? sw?.parts, cutOff = sw?.cutOff ?? sw?.partsOff, cutKg = sw?.cutMassKg ?? sw?.massKg;
    if (V.sweptOff) row('every part it cut through comes off', sw ? `${cutN} cut (${f(cutKg, 0)} kg) of ${sw.parts} reached` : 'swept recorded', sw ? `${cutOff} of ${cutN} off${sw.cutNames?.length ? ` (kept: ${sw.cutNames.slice(0, 4).join(', ')})` : ''}` : 'missing', !!sw && cutOff === cutN);
    if (V.separatedOff && sw) row('and what was held on only through them', `>= ${f(cutKg + sw.separatedMassKg, 0)} kg off (${f(100 * (cutKg + sw.separatedMassKg) / sw.totalMassKg, 0)}%)`, `${f(sw.massOffKg, 0)} kg off`, sw.massOffKg >= cutKg + sw.separatedMassKg - 1);
    if (V.through && sw) {
      const x = sw.endInAttackFrame?.[0] ?? run.attack?.endInCarFrame?.[0];
      row('the ball passes through the car', `ends beyond its far side (x < -${f(1.12 + I.radius, 2)} m)`, `x ${f(x, 2)} m`, x != null && x < -(1.12 + I.radius));
    }
    // Only a projectile that cuts through the car (sweptOff scenarios) can take a wheel by
    // passing through it; a slow lump that strikes a tyre bounces off it.
    const cut = V.sweptOff && sw && (!sw.frontRearJoined || (sw.wheelsCut ?? sw.wheelsSwept) > 0);
    if (V.bondsBroken != null) row('bonds broken', `<= ${V.bondsBroken}`, run.bondsBroken, run.bondsBroken <= V.bondsBroken);
    if (V.wheelsKept) row('wheels kept', cut ? 'measured (its path took a wheel or cut the car)' : `${V.wheelsKept}`, 4 - run.wheelsLost, cut ? null : 4 - run.wheelsLost >= V.wheelsKept);
    if (V.drives && run.driveAway) {
      const m = run.driveAway.metres, expected = V.drives === true || (V.drives === 'unless-cut' && !cut);
      row('drives away (m in 3 s)', expected ? '>= 3' : V.drives === 'no' || cut ? 'not expected (cut in two or wrecked): measured' : '>= 3', f(m), expected ? m >= 3 : null);
    }
    if (V.drives === 'unless-cut' && sw) row('cut in two (front and rear wheels no longer joined)', 'geometry', String(!sw.frontRearJoined), null);
  }
  // Engine evidence on a failing shot.
  if (pr?.infiniteWall || pr?.partialHold) row('nothing holds past its capacity', 'no infinite wall', pr.infiniteWall ? 'INFINITE WALL' : 'partial hold', false, 'engine');
  return rows;
}

const [cmd, a1] = process.argv.slice(2);
if (cmd === 'table') {
  for (const sc of DATA.scenarios) {
    const ex = await expectation(sc);
    const lay = (ex.layers ?? []).map((L) => `${L.kind} ${f(L.thickness * 100, 0)}cm ${f(L.mass, 0)}kg`).join(' | ');
    console.log(`${sc.id.padEnd(34)} ${String(ex.outcome).padEnd(8)} exit ${ex.exit ? `${f(ex.exit.nominal)} [${f(ex.exit.low)}-${f(ex.exit.high)}]` : '-'}${ex.force ? ` F ${f(ex.force.F / 1e3, 0)} kN` : ''} reach ${f(ex.local?.reach, 2)}  ${lay}${ex.error ? ' ' + ex.error : ''}`);
  }
} else if (cmd === 'markdown') {
  // The matrix as a Markdown table, with each profile's verdict rows (scenarios.sh --out files).
  const verdicts = Object.fromEntries(['runtime', 'high'].map((p) => {
    const file = arg(`--${p}`, path.join(ROOT, `target/verify/scenarios-${p}/scenarios.json`));
    return [p, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).rows : []];
  }));
  const cell = (p, id) => {
    const rows = verdicts[p].filter((r) => r.scenario === id);
    if (!rows.length) return 'not run';
    const bad = rows.filter((r) => r.pass === false);
    return bad.length ? `**FAIL** ${bad.map((r) => `${r.check}: ${r.measured}`).join('; ')}` : `PASS (${rows.filter((r) => r.pass).length})`;
  };
  console.log('| Scenario | Expected (derivation) | runtime | high |\n|---|---|---|---|');
  for (const sc of DATA.scenarios) {
    const ex = await expectation(sc);
    const exp = [ex.outcome, ex.force ? `F ${f(ex.force.F / 1e3, 0)} kN vs ${ex.force.resistance?.map((x) => f(x / 1e3, 0)).join('-')} kN` : null,
      sc.expect?.exit && ex.exit ? `exit ${f(ex.exit.nominal)} m/s [${f(ex.exit.low)}-${f(ex.exit.high)}]` : null, sc.expect?.local === true ? `local within ${f(ex.local?.reach, 1)} m` : null,
      sc.expect?.stands === true ? 'roof holds' : null, sc.expect?.more ? `more than ${sc.expect.more}` : null,
      sc.expect?.vehicle ? Object.entries(sc.expect.vehicle).map(([k, v]) => `${k} ${v}`).join(', ') : null, sc.intent ? `*intent: ${sc.intent}*` : null].filter(Boolean).join('; ');
    console.log(`| ${sc.id} | ${exp} | ${cell('runtime', sc.id)} | ${cell('high', sc.id)} |`);
  }
  for (const car of DATA.fleet.cars) for (const c of DATA.fleet.cases) {
    const id = `${car}-${c.case}`;
    console.log(`| ${id} | ${c.expect.outcome}; ${Object.entries(c.expect.vehicle).map(([k, v]) => `${k} ${v}`).join(', ')} | ${cell('runtime', id)} | ${cell('high', id)} |`);
  }
} else if (cmd === 'trials') {
  const want = a1 ?? 'lab';
  if (want === 'fleet') console.log(DATA.fleet.cases.map((c) => c.case).join(','));
  else console.log([...new Set(DATA.scenarios.filter((s) => (s.scene ?? 'lab') === want).map((s) => s.case))].join(','));
} else if (cmd === 'meta') {
  // The trials for one scene: the base meta's (the lab's own) plus the matrix cases, by id.
  const { matrix, townMatrix } = await import('../../structures/vehicle-lab/wall-matrix.mjs');
  const scene = a1, P = JSON.parse(readFileSync(arg('--pack'), 'utf8')), base = JSON.parse(readFileSync(arg('--base'), 'utf8'));
  const ids = new Set(DATA.scenarios.filter((s) => (s.scene ?? 'lab') === scene).map((s) => s.case));
  if (scene === 'lab') DATA.fleet.cases.forEach((c) => ids.add(c.case));
  const wm = (scene === 'town' ? townMatrix(P) : matrix(P, 'all')).filter((t) => ids.has(t.id));
  const own = base.trials.filter((t) => ids.has(t.id));
  const trials = [...own, ...wm].map((t, index) => ({ ...t, index, slot: t.slot ?? (t.at.startsWith('slot/') ? t.at.slice(5).split(',').map(Number) : undefined) }));
  writeFileSync(arg('--out'), JSON.stringify({ ...base, trials }, null, 1));
  console.log(`${arg('--out')}: ${trials.length} trials (${own.length} lab, ${wm.length} matrix)`);
} else if (cmd === 'judge') {
  const profile = a1;
  const files = process.argv.slice(4).filter((x, i, all) => !x.startsWith('--') && !['--lab', '--town', '--out'].includes(all[i - 1]));
  const runs = files.flatMap((x) => JSON.parse(readFileSync(x, 'utf8')).runs);
  const find = (trial, car = 'monster') => runs.filter((r) => r.trial === trial && r.car === car).pop();
  const all = [];
  const exById = {};
  for (const sc of DATA.scenarios) exById[sc.id] = await expectation(sc);
  for (const sc of DATA.scenarios) {
    const ex = { ...exById[sc.id], throughZ: sc.throughZ };
    all.push(...judgeOne(ex, find(sc.case), (id) => find(DATA.scenarios.find((s) => s.id === id)?.case)));
  }
  for (const car of DATA.fleet.cars) for (const c of DATA.fleet.cases) {
    const run = find(c.case, car);
    const T = DATA.targets[c.target], v = run?.impactSpeed ?? c.impactorSpeed, m = run?.mass;
    const F = m ? vehicleImpactForce(m, v).force : null;
    const ex = { id: `${car}-${c.case}`, impactor: { vehicle: car, speed: v, radius: 1 }, expect: c.expect, throughZ: c.throughZ, outcome: 'through',
      force: F && { F, resistance: T.resistanceN }, case: { trial: { at: 'lane/' } } };
    all.push(...judgeOne(ex, run, () => null));
  }
  let fails = 0;
  for (const r of all) {
    const st = r.pass === null ? 'REPORT' : r.pass ? 'PASS' : 'FAIL';
    if (st === 'FAIL') fails += 1;
    r.status = st; r.profile = profile;
    console.log(`${st.padEnd(6)} ${r.scenario.padEnd(32)} ${r.check.slice(0, 46).padEnd(46)} ${String(r.expected).slice(0, 60).padEnd(60)} ${String(r.measured).slice(0, 70)}`);
  }
  console.log(`${all.filter((r) => r.pass).length} pass, ${fails} fail, ${all.filter((r) => r.pass === null).length} reported`);
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify({ profile, rows: all }, null, 1));
  process.exitCode = fails ? 1 : 0;
} else {
  console.error('usage: scenarios.mjs table | trials lab|town|fleet | meta SCENE --pack P --base META --out F | judge PROFILE report.json...');
  process.exitCode = 2;
}
