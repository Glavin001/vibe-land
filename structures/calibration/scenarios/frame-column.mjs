/**
 * Scenario 3 (docs/calibration/frame-column.md): GSA 2016 / UFC 4-023-03
 * alternate-path column removal from a three-storey RC frame with precast
 * floor planks (src/frame-building.mjs), two designs: ordinary (EN 1992 for
 * the intact frame) and robust (UFC linear-static alternate path).
 *
 * Removals, each from the intact building (GSA removes one column per
 * analysis): the ground-floor corner column (x 0, z 0) and the ground-floor
 * edge column next to it (x 6, z 0).
 *
 * The engine has no catenary or membrane action (rigid chunks do not
 * elongate) and no dynamic increase (rigid chunks store no strain energy): a
 * static flexural alternate path is all it can do, and that is what the hand
 * calculation checks.
 */
import * as F from '../src/frame-building.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'frame-column';
export const title = 'Calibration: three-storey RC frame, a ground-floor column removed (GSA / UFC alternate path)';
export const ticks = 600;
export const spacing = 16;
export const band = 0.15;
/** A plank's mortar bed cracking (EN 1996 tension 0.6 MPa) is not the frame failing. */
export const tolerate = '^bed@';
export const configModel = { default: 'gain', section: 'real', rotation: 'real' };
export const models = { real: 'plane frame, gross sections, characteristic capacities (the engineering prediction)', gain: "the default stage's capped square-patch bending gain" };
const CASES = [
  { id: 'ordinary-intact', kind: 'ordinary', removed: [], label: 'Ordinary design, as built' },
  { id: 'ordinary-corner', kind: 'ordinary', removed: [0], label: 'Ordinary design, corner column out' },
  { id: 'ordinary-edge', kind: 'ordinary', removed: [1], label: 'Ordinary design, edge column out' },
  { id: 'robust-intact', kind: 'robust', removed: [], label: 'UFC alternate-path design, as built' },
  { id: 'robust-corner', kind: 'robust', removed: [0], label: 'UFC design, corner column out' },
  { id: 'robust-edge', kind: 'robust', removed: [1], label: 'UFC design, edge column out' },
  // The stair tower the building needs (walk-tested by walk.mjs): its own case, so a stair that does
  // not stand under a configuration is reported as that, not as the frame failing.
  { id: 'with-stair', kind: 'ordinary', removed: [], label: 'Ordinary design with its exterior stair tower', stair: true },
];
const gainS = (sec) => sec.A / Math.min(6 / Math.sqrt(sec.A), 3);

export function hand() {
  return Object.fromEntries(['ordinary', 'robust'].map((kind) => {
    const P = F.params(kind), D = F.design(P, kind), kN = (x) => +(x / 1e3).toFixed(0);
    return [kind, { beam: P.beam, column: P.column, M_Ed_kNm: kN(D.M_Ed), As_cm2: +(D.As * 1e4).toFixed(1), M_Rk_kNm: kN(D.beam.M_Rk), V_Rk_kN: kN(D.beam.V_Rk), column_M_Rk_kNm: kN(D.column.M_Rk), column_N_Rk_kN: kN(D.column.N_Rk),
      beamLoad_kN_per_m: +(F.beamLoad(P) / 1e3).toFixed(1), floorLoad_kPa: +(F.floorLoad(P) / 1e3).toFixed(2), wD_kN_per_m: +(D.wD / 1e3).toFixed(1), wL_kN_per_m: +(D.wL / 1e3).toFixed(1) }];
  }));
}

export function cases() {
  return CASES.map((c) => {
    const P = F.params(c.kind), D = F.design(P, c.kind), b = F.build(P, c.kind, c.removed.map((i) => ({ i, frame: 0 })), { stair: !!c.stair });
    const predictions = {};
    for (const [model, bendingModulus] of [['real', (s) => s.S], ['gain', gainS]]) {
      const r = F.check(P, c.removed, D, { bendingModulus });
      const over = r.bonds.filter((q) => q.u >= 1 - band).sort((x, y) => y.u - x.u).map((q) => ({ key: q.key, u: +q.u.toFixed(3) }));
      predictions[model] = { state: stateOf(r.worst.u, band), u: +r.worst.u.toFixed(3), worst: r.worst.key, over, bonds: Object.fromEntries(r.bonds.map((q) => [q.key, +q.u.toFixed(4)])) };
    }
    return { id: c.id, label: c.label, removed: c.removed.map((i) => `column x ${i * 6}, z 0`), pack: b.pack, names: b.names, bonds: b.bonds, predictions };
  });
}
