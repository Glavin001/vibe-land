/**
 * Calibration 6 (docs/calibration/house-headers.md): the town kit's
 * brick-veneer bungalow, revision 2 (veneer-houses.mjs `revision: 2`), with
 * front-wall bays knocked out beside the door: the door's left jack and king
 * studs, then the stud beside them too -- the bays a car takes out -- and the
 * vehicle test bed's truck hole.
 *
 * The engineer's check (gapCheck): the double top plate spans the gap the
 * removal leaves, between the supports either side of it -- a stud, king or
 * junction stud that remains, or a header on its jacks (the plate bears on
 * the header, the header on its jacks; a header that has lost a jack hangs
 * under the plate from the jack it keeps and supports nothing at that end)
 * -- loaded by the rafter seats and joist ends over it and its own weight
 * (house.mjs plateLoads, from the pack's masses), its ends between pinned and
 * clamped (it runs on over the supports; both bound the truth). Checked
 * against the short-term characteristic strengths (the high profile's
 * VIBE_STRENGTH_SHORT_TERM: a bond holds below its fatal limit).
 *
 * The plate (models):
 * - `real`: two 45 x 90 C24 plies face-nailed one 16d per 406 mm: EN 1995-1-1
 *   Annex B gamma 0.01-0.07 over these gaps, so the plies bend alone: M_Rk =
 *   2 f_m,k b t^2 / 6 = 1.46 kN m;
 * - `kit`: the kit's member, one 90 x 90 with DOUBLE_TOP_PLATE's bending
 *   strength (the same 1.46 kN m) and the solid section's stiffness (4x the
 *   plies': a single span's moment does not depend on it).
 */
import { frame } from './frame2d.mjs';
import { aabb, frontStuds, plateLoads } from './house.mjs';
import { REVISION_2_CONNECTIONS, DOUBLE_TOP_PLATE } from '../../town-kit/src/materials.mjs';

const G = 9.81;
export const C24 = { E: 11e9, fm: 24e6, fv: 4.0e6, fc90: 2.5e6, density: 420 };
export const PLY = { b: 0.09, t: 0.045 };
/** The plate per model: second moment, section modulus, area (m^4, m^3, m^2). */
export const PLATES = {
  real: { I: 2 * PLY.b * PLY.t ** 3 / 12, W: 2 * PLY.b * PLY.t ** 2 / 6, A: 2 * PLY.b * PLY.t, fm: C24.fm },
  kit: { I: PLY.b * (2 * PLY.t) ** 3 / 12, W: PLY.b * (2 * PLY.t) ** 2 / 6, A: 2 * PLY.b * PLY.t, fm: DOUBLE_TOP_PLATE.tensionFatal },
};
/** Capacities (N): a header end on its king stud's 4-8d toe nails; a stud or jack end bearing on 90 x 45 (f_c,90,k). */
export const CAP = {
  headerKing: REVISION_2_CONNECTIONS['header-king'].shear,
  bearing: C24.fc90 * 0.09 * 0.045,
  // Annex B: the plies' composite efficiency over a span L, nails at s (K_ser 0.72 kN/mm, EA of one ply).
  gamma: (L, s = 0.406) => 1 / (1 + Math.PI ** 2 * C24.E * PLY.b * PLY.t * s / (719e3 * L * L)),
};

/** The front wall's members: full-height uprights, jacks and headers, the plate's extent and its cuts. */
export function frontWall(pack, nodeWalls) {
  const s = pack.scenario, nodes = s.nodes.map((_, i) => i).filter((i) => nodeWalls[i] === 'front');
  const studs = frontStuds(pack, nodeWalls);
  const plates = nodes.filter((i) => s.nodeTypes[i] === 'top-plate').map((i) => aabb(s, i)).sort((a, b) => a[0][0] - b[0][0]);
  // A header's chunks (the kit splits one longer than 1.6 m) merged into the header.
  const headers = [];
  for (const [lo, hi] of nodes.filter((i) => s.nodeTypes[i] === 'header').map((i) => aabb(s, i)).sort((a, b) => a[0][0] - b[0][0])) {
    const last = headers.at(-1);
    if (last && Math.abs(lo[0] - last.x1) < 1e-3) last.x1 = +hi[0].toFixed(3); else headers.push({ x0: +lo[0].toFixed(3), x1: +hi[0].toFixed(3) });
  }
  return {
    // Full-height uprights stand on the bottom plate (a cripple over a lintel is the header's, not the wall's).
    uprights: studs.filter((e) => e.y1 > 2.5 && e.y0 < 0.3), jacks: studs.filter((e) => e.type === 'jack-stud'), headers,
    x0: +plates[0][0][0].toFixed(3), x1: +plates.at(-1)[1][0].toFixed(3),
    // The kit's cuts across the plate: where the stage checks its bending.
    cuts: plates.slice(0, -1).map((p) => +p[1][0].toFixed(3)),
  };
}

/**
 * The front wall's plate over the gap the removal leaves (`removedX`: the
 * centre x of each stud, king or jack taken out), as an engineer checks it:
 * the plate spans the gap between the supports either side of it -- a stud,
 * king or junction stud that remains, or a header's jack (the header bears
 * on it, the plate on the header) -- loaded by the seats and joist ends over
 * it, its two ends between pinned and clamped (it runs on over the supports:
 * the truth lies between, both bound it; house.mjs plateSpan). A header that
 * has lost a jack is no support at that end: it hangs under the plate from
 * the jack it keeps. Per model, the plate's utilisation (M / (f_m,k W) or
 * 1.5 V / (f_v,k A)), the bearing at the supports either side (f_c,90,k on
 * 90 x 45), and the gap.
 */
export function gapCheck(pack, nodeWalls, removedX) {
  const W = frontWall(pack, nodeWalls), gone = (x) => removedX.some((r) => Math.abs(r - x) < 2e-3);
  const supports = W.uprights.filter((e) => !gone(e.x)).map((e) => e.x);
  for (const h of W.headers) {
    const jacks = W.jacks.filter((e) => e.x > h.x0 && e.x < h.x1);
    // On both its jacks, the header carries the plate over its whole length.
    if (jacks.every((e) => !gone(e.x))) for (let x = h.x0; x <= h.x1 + 1e-9; x += 0.1) supports.push(+Math.min(x, h.x1).toFixed(3));
    else supports.push(...jacks.filter((e) => !gone(e.x)).map((e) => e.x));
  }
  const sx = [...new Set(supports)].sort((a, b) => a - b);
  let from = sx[0], to = sx[1];
  for (let k = 1; k < sx.length - 1; k++) if (sx[k + 1] - sx[k] > to - from) { from = sx[k]; to = sx[k + 1]; }
  const bounds = ['pinned', 'fixed'].map((ends) => span(pack, from, to, ends));
  const M = Math.max(...bounds.map((b) => b.M)), Mlow = Math.min(...bounds.map((b) => b.M)), V = Math.max(...bounds.map((b) => b.V));
  const util = (model) => { const P = PLATES[model]; return { u: Math.max(M / (P.fm * P.W), 1.5 * V / (C24.fv * P.A)), uLow: Math.max(Mlow / (P.fm * P.W), 1.5 * V / (C24.fv * P.A)) }; };
  return { from, to, gap: +(to - from).toFixed(3), M, Mlow, V, real: util('real'), kit: util('kit'), endReaction: endReactions(pack, from, to) };
}

/** The plate over [from, to] alone, its ends pinned or clamped: its worst |M| and |V| (frame2d). */
function span(pack, from, to, ends, step = 0.025) {
  const loads = plateLoads(pack).filter((l) => l.x > from && l.x < to);
  const pts = new Set([from, to, ...loads.map((l) => l.x)]);
  for (let x = from; x <= to; x += step) pts.add(+x.toFixed(3));
  const xs = [...new Set([...pts].map((x) => +x.toFixed(3)))].filter((x) => x >= from && x <= to).sort((a, b) => a - b);
  const f = frame(), node = new Map(xs.map((x) => [x, f.node(x, 0)])), P = PLATES.kit, ms = [];
  for (let k = 0; k < xs.length - 1; k++) ms.push(f.member(node.get(xs[k]), node.get(xs[k + 1]), { E: C24.E, A: P.A, I: P.I, w: P.A * C24.density * G }));
  f.fix(node.get(xs[0]), ends === 'fixed' ? 'xyz' : 'xy'); f.fix(node.get(xs.at(-1)), ends === 'fixed' ? 'xyz' : 'y');
  for (const l of loads) f.load(node.get(+l.x.toFixed(3)), 0, -l.P, 0);
  const r = f.solve();
  let M = 0, V = 0;
  ms.forEach((m, k) => { for (const t of [0, xs[k + 1] - xs[k]]) { const q = r.at(m, t); M = Math.max(M, Math.abs(q.M)); V = Math.max(V, Math.abs(q.V)); } });
  return { M, V };
}

/** The reaction at each end support of a gap: the plate over the gap simply supported, plus half the next spans' (a bound for the bearing check). */
function endReactions(pack, from, to) {
  const loads = plateLoads(pack), w = PLATES.kit.A * C24.density * G;
  const inGap = loads.filter((l) => l.x > from && l.x < to);
  const L = to - from, total = inGap.reduce((t, l) => t + l.P, 0) + w * L;
  const left = inGap.reduce((t, l) => t + l.P * (to - l.x) / L, 0) + w * L / 2;
  // The next stud span each side carries about one bay's seat (0.6 m of the line load) to the end support.
  const line = loads.reduce((t, l) => t + l.P, 0) / 9.72;
  const R = [left + 0.3 * line, total - left + 0.3 * line];
  return R.map((r, k) => ({ x: k ? to : from, R: r, u: r / CAP.bearing }));
}
