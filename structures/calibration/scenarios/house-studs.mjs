/**
 * Scenario 2 (docs/calibration/house-studs.md): the town kit's brick-veneer
 * bungalow, its front wall's studs taken out one at a time from the middle of
 * the plain run between the partition junction (x -1.8) and the door's king
 * stud (x 1.532): x -0.037, 0.563, -0.637, 1.163, -1.238 -- gaps over the
 * top plate of 1.2, 1.8, 2.4, 2.77 and 3.33 m.
 *
 * Three houses per step: the frame alone with its front top plate re-chunked
 * (house.mjs rechunk: the stage checks the plate's bending where the hand
 * calculation does), the frame alone as the kit authors it (the plate one
 * rigid chunk per 2.4 m), and the house as built (brick and board on) re-chunked.
 *
 * Models: `real` -- the engineering prediction for the minutes after the
 * studs come out: the plate breaks at its short-term characteristic bending
 * strength (C24 f_m,k 24 MPa), bearing perpendicular to the grain is a
 * deformation, not a collapse; `kit` -- what the stage should do with the
 * kit's materials and true sections: damage above the sustained limit (k_mod
 * 0.6) and the stud-plate joints' bearing limit (0.6 x 2.5 MPa) as brittle;
 * `gain` -- the same with the default stage's capped bending gain.
 */
import * as H from '../src/house.mjs';
import { withoutNodes } from '../src/pack.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'house-studs';
export const title = 'Calibration: brick-veneer bungalow, front-wall studs removed one at a time';
export const ticks = 600;
export const spacing = 14;
/** The native app's cap with the destructible fleet (the kit qualifies at 16: VIBE_CITY_NATIVE_STRESS_ITERATIONS=16 reruns it so). */
export const iterations = 64;
export const band = 0.15;
export const configModel = { default: 'gain', section: 'kit', rotation: 'kit' };
export const models = {
  real: 'short-term C24 strength, bearing not a collapse mode (the engineering prediction)',
  kit: "the kit's sustained limits (k_mod 0.6) and stud-plate bearing as brittle, true sections",
  gain: "the kit's limits with the default stage's capped square-patch bending gain",
};
const ORDER = [-0.037, 0.563, -0.637, 1.163, -1.238];
const STEPS = [0, 1, 2, 3, 4, 5];
const VARIANTS = [
  { key: 'frame', label: 'frame, plate re-chunked', frameOnly: true, rechunked: true },
  { key: 'authored', label: 'frame as authored', frameOnly: true, rechunked: false },
  { key: 'built', label: 'as built, plate re-chunked', frameOnly: false, rechunked: true },
];

const gainS = (A) => A / Math.min(6 / Math.sqrt(A), 3);

/** Per-model utilisations of the plate at x and the stud-plate bearing at a stud, from both end-fixity bounds. */
function predict(variant, pack, nodeWalls, removed, cutsAt) {
  const bounds = ['pinned', 'fixed'].map((ends) => H.plateSpan(pack, nodeWalls, removed, { ends }));
  const A = H.PLATE.b * H.PLATE.h, S = H.PLATE.b * H.PLATE.h ** 2 / 6, Sg = gainS(A);
  const at = (r, x) => { const c = r.checks.reduce((m, q) => (Math.abs(q.x - x) < Math.abs(m.x - x) ? q : m)); return c; };
  const out = {};
  for (const model of ['real', 'kit', 'gain']) {
    const lim = model === 'real' ? H.PLATE.fm : H.PLATE.longTerm * H.PLATE.fm, limV = model === 'real' ? H.PLATE.fv : H.PLATE.longTerm * H.PLATE.fv;
    const mod = model === 'gain' ? Sg : S;
    const plate = (r, x) => { const c = at(r, x); return Math.max(Math.abs(c.M) / mod / lim, Math.abs(c.V) / A / limV); };
    // Where the stage can see it: everywhere (re-chunked: at the cuts) or only at the kit's seams (authored).
    const where = variant.rechunked ? cutsAt.filter((x) => x > -1.8 && x < 1.532) : [0.24];
    const bonds = {}, over = [];
    let worst = { key: null, u: 0 }, lo = Infinity;
    for (const r of bounds) {
      let w = 0;
      for (const x of where) { const u = plate(r, x); bonds[`plate@${x}`] = Math.max(bonds[`plate@${x}`] ?? 0, u); w = Math.max(w, u); if (u > worst.u) worst = { key: `plate@${x}`, u }; }
      // The real plate also breaks between cuts: its continuum maximum.
      if (model === 'real') { const m = Math.max(...r.checks.map((c) => Math.max(Math.abs(c.M) / S / lim, Math.abs(c.V) / A / limV))); w = Math.max(w, m); if (m > worst.u) worst = { key: 'plate (continuum)', u: m }; }
      for (const q of r.reactions) {
        if (model === 'real') continue;
        const u = q.R / (H.PLATE.longTerm * 2.5e6 * 0.09 * 0.045);
        bonds[`stud-top@${q.x}`] = Math.max(bonds[`stud-top@${q.x}`] ?? 0, u);
        w = Math.max(w, u); if (u > worst.u) worst = { key: `stud-top@${q.x}`, u };
      }
      lo = Math.min(lo, w);
    }
    for (const [k, u] of Object.entries(bonds)) if (u >= 1 - band) over.push({ key: k, u: +u.toFixed(3) });
    over.sort((a, b) => b.u - a.u);
    // The two end-fixity bounds: holds only if both say so, collapses only if both do.
    let state = stateOf(worst.u, band);
    if (stateOf(lo, band) !== state) state = 'either';
    // As built, the gypsum board screwed to plate and studs is a deep beam an engineer does not count: it can only help.
    if (variant.key === 'built' && state === 'collapses') state = 'either';
    out[model] = { state, u: +worst.u.toFixed(3), uLow: +lo.toFixed(3), worst: worst.key, over, bonds: Object.fromEntries(Object.entries(bonds).map(([k, u]) => [k, +u.toFixed(4)])), gap: +bounds[0].gap.toFixed(2) };
  }
  return out;
}

/** Bond keys for the pack's front-wall plate and stud-top bonds (null elsewhere). */
function keys(pack, nodeWalls) {
  const s = pack.scenario, plate = (i) => nodeWalls[i] === 'front' && s.nodeTypes[i] === 'top-plate';
  const stud = (i) => nodeWalls[i] === 'front' && ['stud', 'king-stud', 'junction-stud'].includes(s.nodeTypes[i]);
  return s.bonds.map((b) => {
    if (plate(b.node0) && plate(b.node1) && Math.abs(b.normal.x) > 0.5) return `plate@${+b.centroid.x.toFixed(3)}`;
    const st = plate(b.node0) && stud(b.node1) ? b.node1 : plate(b.node1) && stud(b.node0) ? b.node0 : null;
    if (st == null) return null;
    const [lo, hi] = H.aabb(s, st);
    return `stud-top@${+((lo[0] + hi[0]) / 2).toFixed(3)}`;
  });
}

export function hand() {
  const { pack, metadata } = H.bungalow({ frameOnly: true }), loads = H.plateLoads(pack);
  return {
    plate: H.PLATE, line_kN_per_m: +(loads.filter((l) => l.x > -1.8 && l.x < 1.532).reduce((t, l) => t + l.P, 0) / 3.332 / 1e3).toFixed(3),
    seat_kN: +(loads.find((l) => l.what === 'rafter seat' && Math.abs(l.x) < 0.01).P / 1e3).toFixed(3),
    joist_kN: +(loads.find((l) => l.what === 'ceiling joist' && l.x > 0).P / 1e3).toFixed(3),
    order: ORDER,
    steps: STEPS.map((n) => { const rm = ORDER.slice(0, n); return Object.fromEntries(['pinned', 'fixed'].map((ends) => { const r = H.plateSpan(pack, metadata.nodeWalls, rm, { ends }); return [ends, { gap: +r.gap.toFixed(2), M_kNm: +(r.worst.M / 1e3).toFixed(2), x: r.worst.x, uSustained: +r.worst.u.toFixed(3), uShortTerm: +r.worst.uFatal.toFixed(3), studReaction_kN: +(r.maxBearing.R / 1e3).toFixed(2), bearingShortTerm: +r.maxBearing.bearing.toFixed(3) }]; })); }),
  };
}

export function cases() {
  const out = [];
  for (const v of VARIANTS) {
    const base = H.bungalow({ frameOnly: v.frameOnly });
    let pack = base.pack, walls = base.metadata.nodeWalls, cuts = [];
    if (v.rechunked) {
      const c = H.plateCuts(pack, walls); cuts = c.cuts;
      const r = H.rechunk(pack, walls, (i) => (c.plates.includes(i) ? c.cuts : null));
      pack = r.pack; walls = r.nodeWalls;
    }
    const studs = H.frontStuds(pack, walls);
    for (const n of STEPS) {
      const removed = ORDER.slice(0, n), drop = new Set(studs.filter((e) => removed.some((x) => Math.abs(x - e.x) < 1e-3)).flatMap((e) => e.nodes));
      const { pack: p, map } = withoutNodes(pack, (i) => drop.has(i));
      const w = []; for (const [o, nIdx] of map) w[nIdx] = walls[o];
      const names = p.scenario.nodeTypes.map((t, i) => `${t}${w[i] ? `/${w[i]}` : ''}#${i}`);
      // The predictions use the bungalow's own loads (the same with or without skin for the frame's plate; as built the lining adds to the joists).
      out.push({ id: `${v.key}-${n}`, label: `${n} stud${n === 1 ? '' : 's'} out (${v.label})${n ? `: ${predict(v, p, w, removed, cuts).real.gap} m gap` : ''}`, removed: removed.map((x) => `stud@${x}`),
        pack: p, names, bonds: keys(p, w), predictions: predict(v, p, w, removed, cuts) });
    }
  }
  return out;
}
