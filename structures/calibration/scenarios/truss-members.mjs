/**
 * Scenario 1b (docs/calibration/truss-members.md): the glulam Pratt truss
 * footbridge (src/truss.mjs) under its deck and a crowd, members cut.
 *
 * In removal order: the midspan vertical (B3-T3: next to no force under a
 * symmetric load), then a centre-panel diagonal (T2-B3). And single cuts,
 * each from the intact truss: a bottom chord in the centre panel, an end
 * diagonal, a top chord. A Pratt truss is statically determinate: an
 * engineer predicts that cutting any member that carries load makes it a
 * mechanism, unless its joints can carry the panel's shear as a Vierendeel
 * frame -- these dowelled joints cannot (their moment capacity is a few kN m).
 */
import * as T from '../src/truss.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'truss-members';
export const title = 'Calibration: glulam Pratt truss footbridge, members cut';
export const ticks = 600;
export const spacing = 9;
export const band = 0.15;
export const configModel = { default: 'gain', section: 'kit', rotation: 'kit' };
export const models = {
  real: 'pin-jointed truss (dowelled joints slip: secondary moments relax) or, past a cut that makes it a mechanism, the rigid-jointed frame against short-term capacities',
  kit: 'rigid-jointed frame, the engine failure law at k_mod 0.9 (the engine elastic), true sections',
  gain: 'the same with the default stage capped square-patch bending gain',
};
const CASES = [
  { id: 'step0', label: 'As built: 24 m Pratt truss, deck and crowd on', removed: [] },
  { id: 'step1', label: 'Midspan vertical cut (B3-T3)', removed: ['B3-T3'] },
  { id: 'step2', label: 'And a centre-panel diagonal cut (T2-B3)', removed: ['B3-T3', 'T2-B3'] },
  { id: 'chord', label: 'Bottom chord cut in the centre panel (B2-B3), alone', removed: ['B2-B3'] },
  { id: 'end-diagonal', label: 'End-panel diagonal cut (T1-B2), alone', removed: ['T1-B2'] },
  { id: 'top-chord', label: 'Top chord cut (T2-T3), alone', removed: ['T2-T3'] },
];

const gainS = (b, h) => { const A = b * h; return A / Math.min(6 / Math.sqrt(A), 3); };
const keyOf = (b) => (b.type === 'bearing' || b.type === 'cross-beam' ? b.member : b.end === 0 ? `${b.member}:0` : b.end === 1 ? `${b.member}:1` : b.at != null ? `${b.member}:mid` : b.member);

function predict(removed, faces) {
  const P = T.TRUSS, out = {};
  // Pin-jointed: a mechanism (singular) or each member's axial force against its connection / section.
  let pinnedU = null;
  try {
    const f = T.forces(P, removed, { pinned: true }), D = T.design(P);
    pinnedU = Math.max(...Object.entries(f).map(([idm, q]) => {
      const A = P.width * q.depth, web = q.type !== 'bottom-chord' && q.type !== 'top-chord', N = q.mid.N;
      const t = web ? T.connection(D.F_Ed[idm], q.depth, P).Rk / A : 28e6, c = 28e6;
      return N > 0 ? N / A / t : -N / A / c;
    }));
  } catch { pinnedU = Infinity; }
  const rigid = (limit, bendingModulus) => T.check(P, removed, { faces, limit, bendingModulus });
  const short = rigid('short'), kit = rigid('sustained'), gain = rigid('sustained', gainS);
  for (const [model, c, extra] of [['real', short, pinnedU], ['kit', kit, null], ['gain', gain, null]]) {
    let u = c.worst.u, worst = c.worst.key;
    // Real: the joints slip, so an intact (or still triangulated) truss is read pinned; a mechanism falls back on the rigid frame.
    if (model === 'real') { if (Number.isFinite(extra)) { u = extra; worst = 'pin-jointed member'; } }
    const over = c.bonds.filter((b) => b.u >= 1 - band).sort((a, b) => b.u - a.u).map((b) => ({ key: b.key, u: +b.u.toFixed(3) }));
    // Both trusses carry the same: each bond key twice (S: and N:).
    const both = (k) => [`S:${k}`, `N:${k}`];
    out[model] = { state: stateOf(u, band), u: +u.toFixed(3), worst: worst.includes(':') && !worst.startsWith('pin') ? `S:${worst}` : worst, over: over.flatMap((o) => both(o.key).map((key) => ({ ...o, key }))), bonds: Object.fromEntries(c.bonds.flatMap((b) => both(b.key).map((k) => [k, +b.u.toFixed(4)]))), pinned: Number.isFinite(pinnedU) ? +pinnedU.toFixed(3) : 'mechanism' };
  }
  return out;
}

export function hand() {
  const P = T.TRUSS, D = T.design(P), dw = T.dowel(P), f = T.forces(P, [], { pinned: true });
  return {
    truss: { ...P, crowd_kPa: +(T.crowd(P.panels * P.panel) / 1e3).toFixed(2), panelLoad_kN: +(T.panelLoad(P) / 1e3).toFixed(1), kmod: T.KMOD },
    dowel: { perPlane_kN: +(dw.perPlane / 1e3).toFixed(2), perDowel_kN: +(dw.perDowel / 1e3).toFixed(2), modes_kN: Object.fromEntries(Object.entries(dw.modes).map(([k, v]) => [k, +(v / 1e3).toFixed(1)])) },
    members: Object.fromEntries(Object.entries(f).map(([k, q]) => [k, { type: q.type, N_kN: +(q.mid.N / 1e3).toFixed(1), F_Ed_kN: +(D.F_Ed[k] / 1e3).toFixed(1), ...(q.type === 'bottom-chord' || q.type === 'top-chord' ? {} : (() => { const c = T.connection(D.F_Ed[k], q.depth, P); return { dowels: c.n, R_k_kN: +(c.Rk / 1e3).toFixed(0) }; })()) }])),
  };
}

export function cases() {
  const faces = T.build(T.TRUSS, []).radius.map((r) => r.r);
  return CASES.map((c) => {
    const b = T.build(T.TRUSS, c.removed);
    return { id: c.id, label: c.label, removed: c.removed, pack: b.pack, names: b.names, bonds: b.bonds.map(keyOf), predictions: predict(c.removed, faces) };
  });
}
