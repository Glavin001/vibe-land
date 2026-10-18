/**
 * Scenario 4 (docs/calibration/demolition.md): controlled demolition of the
 * three-storey RC frame (src/frame-building.mjs, ordinary design) by
 * explosive charges on its ground-floor columns, fired in delay sequences
 * as a demolition contractor would.
 *
 * Charges: every ground-floor column is loaded; a firing cuts its column
 * line (both frames) in one tick (server/src/calibration_charges.rs: the
 * column section is a static support removed at the firing's tick -- what a
 * cutting charge does to the member; the blast's air pressure on the rest is
 * not modelled). Pre-weakening: the floors are untied precast planks and the
 * building is stripped (no partitions, no cladding), as before a blowdown.
 *
 * Sequences (delays as in practice, 0.25-0.5 s between rows):
 *   standing   charges placed, none fired: it must stand on them (control)
 *   east-first lines x 18, 12, 6, 0 at 1.0, 1.3, 1.6, 1.9 s: the collapse
 *              runs from east to west, each bay folding in
 *   core-first lines x 6, 12 at 1.0 s, then x 0, 18 at 1.25 s: the middle drops,
 *              the outer bays pulled in after it -- into the footprint
 *
 * The hand calculation (plane frame, as for the column-removal scenario) says
 * which beams fail at each firing; where the debris goes is the demolition
 * engineer's call, recorded as `expect`: the pile stays within the footprint
 * plus a bay's half-width (3 m), its centroid moves toward the side fired
 * first (east-first) or stays (core-first) within 1.5 m, and no chunk of the
 * frame is thrown beyond 6 m of the footprint.
 */
import * as F from '../src/frame-building.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'demolition';
export const title = 'Calibration: controlled demolition of a three-storey RC frame';
export const ticks = 900;
export const spacing = 40;
export const band = 0.15;
export const configModel = { default: 'gain', section: 'real', rotation: 'real' };
export const models = { real: 'plane frame per firing stage (the engineering prediction)', gain: 'the same with the default capped gain' };
const SEQUENCES = [
  { id: 'standing', label: 'Charges placed, none fired', firings: [] },
  { id: 'east-first', label: 'East first: lines x 18, 12, 6, 0 at 1.0 / 1.3 / 1.6 / 1.9 s', firings: [[60, [3]], [78, [2]], [96, [1]], [114, [0]]] },
  { id: 'core-first', label: 'Core first: lines x 6, 12 at 1.0 s, then x 0, 18 at 1.25 s', firings: [[60, [1, 2]], [75, [0, 3]]] },
];

export function cases() {
  const P = F.params('ordinary'), D = F.design(P, 'ordinary');
  const b = F.build(P, 'ordinary', [], { charged: true });
  const xs = F.columnsX(P), footprint = { x: [xs[0] - P.column / 2, xs.at(-1) + P.column / 2], z: [-P.column / 2, P.depth + P.column / 2] };
  return SEQUENCES.map((q) => {
    const fired = [], stages = [];
    for (const [tick, lines] of q.firings) {
      fired.push(...lines);
      let stage;
      try {
        const r = F.check(P, fired, D);
        stage = { tick, lines: [...lines], fired: [...fired], u: +r.worst.u.toFixed(2), worst: r.worst.key, failing: r.bonds.filter((x) => x.u >= 1).map((x) => x.key).slice(0, 24) };
      } catch { stage = { tick, lines: [...lines], fired: [...fired], u: Infinity, worst: 'no ground support left: the frame falls', failing: [] }; }
      stages.push(stage);
    }
    const charges = q.firings.map(([tick, lines]) => ({ tick, boxes: b.supports.filter((s) => lines.includes(s.i)).map((s) => s.box) }));
    // The standing case keeps its supports: a firing nobody reaches (past the run).
    if (!charges.length) charges.push({ tick: 1_000_000, boxes: b.supports.map((s) => s.box) });
    else { const all = new Set(q.firings.flatMap(([, l]) => l)); const left = b.supports.filter((s) => !all.has(s.i)); if (left.length) charges.push({ tick: 1_000_000, boxes: left.map((s) => s.box) }); }
    const fell = stages.length > 0;
    const u = fell ? Math.max(...stages.map((s) => s.u)) : F.check(P, [], D).worst.u;
    const pred = { state: fell ? 'collapses' : stateOf(u, band), u: Number.isFinite(u) ? +u.toFixed(3) : 99, worst: fell ? stages[0].worst : F.check(P, [], D).worst.key, over: [], bonds: {}, stages };
    return {
      id: q.id, label: q.label, removed: q.firings.map(([t, l]) => `t ${(t / 60).toFixed(2)} s: line${l.length > 1 ? 's' : ''} x ${l.map((i) => xs[i]).join(', ')}`),
      pack: b.pack, names: b.names, bonds: b.bonds, charges, masses: b.pack.scenario.nodes.map((n) => n.mass),
      predictions: { real: pred, gain: pred },
      expect: fell ? { footprint, margin: 3, thrown: 6, centroidShiftX: q.id === 'east-first' ? [-1.5, 6] : [-1.5, 1.5], firings: stages.map((s) => ({ tick: s.tick, within: 30, mustBreak: s.failing })) } : { standing: true },
    };
  });
}

/**
 * The demolition's own checks (run.mjs calls a scenario's judgeCase): the
 * frame's chunks (not the stair tower) at the end of the run, mass-weighted.
 */
export function judgeCase(spec, report, c) {
  if (!c.expect || c.expect.standing) return null;
  const [n0, n1] = c.nodes, first = report.positions[0].p, last = report.positions.at(-1).p, e = c.expect;
  let m = 0, mx0 = 0, mx1 = 0, inside = 0, thrown = 0, top = 0;
  for (let i = n0; i < n1; i++) {
    const k = i - n0, w = c.masses?.[k] ?? 0;
    if (!(w > 0) || /^stair|^half-landing|^step-/.test(c.names[k])) continue;
    const x0 = first[3 * i], x = last[3 * i], y = last[3 * i + 1], z = last[3 * i + 2] - c.offset[2];
    if (!Number.isFinite(x)) continue;
    m += w; mx0 += w * x0; mx1 += w * x;
    const out = Math.max(e.footprint.x[0] - x, x - e.footprint.x[1], e.footprint.z[0] - z, z - e.footprint.z[1], 0);
    if (out <= e.margin) inside += w;
    if (out > e.thrown) thrown += 1;
    top = Math.max(top, y);
  }
  const shift = (mx1 - mx0) / m;
  const firings = e.firings.map((f) => {
    const broke = (report.cases[c.id]?.broken ?? []).filter((b) => b.tick >= f.tick && b.tick <= f.tick + f.within).length;
    return { tick: f.tick, brokeWithin: broke, ok: broke > 0 };
  });
  const ok = inside / m >= 0.95 && thrown === 0 && shift >= e.centroidShiftX[0] && shift <= e.centroidShiftX[1] && firings.every((f) => f.ok);
  return { ok, inFootprint: +(inside / m).toFixed(3), thrownChunks: thrown, centroidShiftX: +shift.toFixed(2), pileTop: +top.toFixed(2), firings };
}
