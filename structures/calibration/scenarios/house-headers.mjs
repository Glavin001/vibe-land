/**
 * Scenario 6 (docs/calibration/house-headers.md): the town kit's brick-veneer
 * bungalow as revision 2 authors it (veneer-houses.mjs `revision: 2`), as
 * built (brick and board on), with front-wall bays knocked out beside the
 * door the way a car takes them -- frame and skin both:
 *
 *   intact      nothing out
 *   bay1        the door's left jack and king studs (x 1.577, 1.532)
 *   bay2        and the stud beside them (x 1.163)
 *   truck       the five studs of the test bed truck's hole (x -1.238 .. 1.163;
 *               the framed-house trial: 5 t at 21.7 m/s, impact at x -0.08,
 *               its reach 1.52 m)
 *   truck-door  the truck's hole and the door's left jack and king
 *
 * Models (house-headers.mjs gapCheck, the plate over the gap between pinned
 * and clamped): `real`, the double top plate as two nailed plies (M_Rk 1.46
 * kN m); `kit`, the kit's member, its bending strength DOUBLE_TOP_PLATE's
 * (the same 1.46 kN m) -- the two differ in stiffness only, which a single
 * span's moment does not see. Skin joints (drywall screws, wall ties,
 * mortar, glazing and frame fixings) may break: knocked-out bays crack the
 * board and the brick around them; the frame is what holds or falls.
 */
import * as H from '../src/house-headers.mjs';
import { aabb } from '../src/house.mjs';
import { withoutNodes } from '../src/pack.mjs';
import { stateOf } from '../src/scenario.mjs';
import { buildVeneerHouse } from '../../town-kit/src/veneer-houses.mjs';

export const id = 'house-headers';
export const title = 'Calibration: brick-veneer bungalow (revision 2), front-wall bays knocked out beside the door';
export const ticks = 600;
export const spacing = 14;
export const iterations = 64;
export const band = 0.15;
export const tolerate = '^skin:';
export const models = {
  real: 'the double top plate as two nailed plies (EN 1995-1-1 Annex B), short-term C24 strength',
  kit: "the kit's revision-2 plate (one member, the plies' bending strength)",
};
export const configModel = { default: 'kit', runtime: 'kit', section: 'kit', rotation: 'kit', high: 'kit' };

const STUDS = { bay1: [1.532, 1.577], bay2: [1.163, 1.532, 1.577], truck: [-1.238, -0.637, -0.037, 0.563, 1.163] };
export const CASES = [
  { id: 'intact', removed: [], bay: null },
  { id: 'bay1', removed: STUDS.bay1, bay: [1.45, 1.65] },
  { id: 'bay2', removed: STUDS.bay2, bay: [0.9, 1.65] },
  { id: 'truck', removed: STUDS.truck, bay: [-1.5, 1.3] },
  { id: 'truck-door', removed: [...STUDS.truck, ...STUDS.bay1], bay: [-1.5, 1.65] },
];
const KNOCKED = new Set(['stud', 'king-stud', 'jack-stud', 'cripple-stud', 'brick-veneer', 'veneer-lintel-course', 'drywall', 'glazing', 'window-frame', 'door-frame']);
const SKIN = /^(drywall-screw|wall-tie|veneer-mortar|glazing|window-fixing|ivory-trim)/;

/** The bungalow without what a car knocks out of the front wall over [x0, x1]: frame and skin whose centre lies there. */
export function knockOut(pack, nodeWalls, bay) {
  if (!bay) return { pack, nodeWalls };
  const s = pack.scenario;
  const { pack: p, map } = withoutNodes(pack, (i) => { const [lo, hi] = aabb(s, i), c = (lo[0] + hi[0]) / 2; return hi[2] < -3.5 && KNOCKED.has(s.nodeTypes[i]) && c >= bay[0] && c <= bay[1]; });
  const w = []; for (const [o, n] of map) w[n] = nodeWalls[o];
  return { pack: p, nodeWalls: w };
}

/** Bond keys: the front plate's cuts, stud tops, header ends, and every skin joint (tolerated). */
function keys(pack, nodeWalls) {
  const s = pack.scenario, mats = pack.defaults.solver.materials, t = s.nodeTypes;
  const front = (i) => nodeWalls[i] === 'front', x = (b) => +b.centroid.x.toFixed(3);
  return s.bonds.map((b) => {
    const name = mats[b.m].name, a = b.node0, c = b.node1, pair = [t[a], t[c]].sort().join('/');
    if (SKIN.test(name)) return `skin:${name}@${x(b)}`;
    if (!front(a) || !front(c)) return null;
    if (pair === 'top-plate/top-plate' && Math.abs(b.normal.x) > 0.5) return `plate@${x(b)}`;
    if (['stud/top-plate', 'king-stud/top-plate', 'junction-stud/top-plate'].includes(pair)) return `stud-top@${x(b)}`;
    if (pair === 'header/king-stud') return `header-king@${x(b)}`;
    if (pair === 'header/jack-stud') return `header-jack@${x(b)}`;
    if (pair === 'header/top-plate') return `header-plate@${x(b)}`;
    return null;
  });
}

/** Per-model predictions from the gap check. */
function predict(pack, nodeWalls, removed, cutKeys) {
  const g = H.gapCheck(pack, nodeWalls, removed), out = {};
  for (const model of ['real', 'kit']) {
    const { u, uLow } = g[model];
    let state = stateOf(u, band);
    if (stateOf(uLow, band) !== state) state = 'either';
    // The cuts in the gap: where the stage can break the plate (the critical bonds of a collapse).
    const inGap = cutKeys.filter((k) => { const cx = +k.split('@')[1]; return cx > g.from && cx < g.to; });
    const over = u > 1 + band ? inGap.map((key) => ({ key, u: +u.toFixed(3) })) : [];
    // As built, the paths an engineer does not count can only help: the gypsum board screwed to the
    // plate and studs (a deep beam), the ceiling lining and the ridge board bridging the rafters over
    // the gap. A plate past its strength is then a prediction of `either`, not of collapse (house-studs).
    if (state === 'collapses') state = 'either';
    out[model] = { state, u: +u.toFixed(3), uLow: +uLow.toFixed(3), worst: `plate over ${g.from}..${g.to} (${g.gap} m)`, over, bonds: {},
      gap: g.gap, M_kNm: [+(g.Mlow / 1e3).toFixed(2), +(g.M / 1e3).toFixed(2)], endBearing: g.endReaction.map((q) => +q.u.toFixed(3)) };
  }
  return out;
}

export function hand() {
  const { pack, metadata } = buildVeneerHouse({ storeys: 1, revision: 2 });
  return Object.fromEntries(CASES.map((c) => {
    const g = H.gapCheck(pack, metadata.nodeWalls, c.removed);
    return [c.id, { gap: [g.from, g.to, g.gap], M_kNm: [+(g.Mlow / 1e3).toFixed(2), +(g.M / 1e3).toFixed(2)], V_kN: +(g.V / 1e3).toFixed(2),
      real: [+g.real.uLow.toFixed(3), +g.real.u.toFixed(3)], kit: [+g.kit.uLow.toFixed(3), +g.kit.u.toFixed(3)], gamma: +H.CAP.gamma(g.gap).toFixed(3),
      endBearing: g.endReaction.map((q) => ({ x: q.x, kN: +(q.R / 1e3).toFixed(2), u: +q.u.toFixed(3) })) }];
  }));
}

export function cases() {
  const { pack, metadata } = buildVeneerHouse({ storeys: 1, revision: 2 });
  return CASES.map((c) => {
    const { pack: p, nodeWalls } = knockOut(pack, metadata.nodeWalls, c.bay);
    const bonds = keys(p, nodeWalls), cutKeys = [...new Set(bonds.filter((k) => k?.startsWith('plate@')))];
    const names = p.scenario.nodeTypes.map((t, i) => `${t}${nodeWalls[i] ? `/${nodeWalls[i]}` : ''}#${i}`);
    return { id: c.id, label: c.removed.length ? `${c.id}: front-wall uprights at x ${c.removed.join(', ')} out` : 'intact', removed: c.removed.map((x) => `upright@${x}`),
      pack: p, names, bonds, predictions: predict(pack, metadata.nodeWalls, c.removed, cutKeys) };
  });
}
