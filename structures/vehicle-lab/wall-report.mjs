#!/usr/bin/env node
// Judge wall-matrix runs (scripts/wall-matrix.sh; the probe is
// server/src/wall_matrix.rs): did each impactor go through, slow, stop or
// bounce, and was a stop or bounce physical?
//
//   node structures/vehicle-lab/wall-report.mjs [--out merged.json] [--baseline other.json] report.json...
//
// Outcome, along the approach (v the impactor's velocity along it, past how
// far its centre -- a car's front -- got beyond the aim point on the face):
//   through   past > layer + 2r (+1 m for a car): it went through the struck layer
//   bounce    v ends below -10% of v_in: thrown back out
//   stopped   |v| ends under 10% of v_in and it did not get through
//   slowed    otherwise (lodged in, or still moving in)
//   miss      no contact
// Physical? Grounded in momentum and strength, no tuned threshold:
//   INFINITE  the tick that took the most momentum asked a force m dv/dt of the
//             chunks the impactor touched that their bonds cannot give (every
//             bond leaving the set at its fatal limits, plus its weight), and
//             they all stayed on the anchored (kinematic) body: no static
//             equilibrium exists, so a real wall would have broken there.
//   PARTIAL   some were freed, but what stayed anchored took more than its bonds can.
//   PULSE     the tick's average force (what the stage loads the bonds with) was
//             within what they carry, but the hit's real peak -- an elastic
//             sphere's Hertz pulse, a millisecond or so, not a tick -- was not:
//             a real wall breaks locally (punches) where the stage held.
//   held      the peak force was within what the touched chunks' bonds can carry:
//             a real wall could have held it (a stop or bounce may be physical).
// Energy: the struck structure's fragments' translational kinetic energy
// against what the impactor lost plus what their fall released (sampled every
// third tick for 1.5 s after contact; rotation left out, so a lower bound):
// over 1.05 is energy from nowhere (ENERGY, reported). debrisUp: the fastest
// upward fragment; ballUp: the upward speed the impactor gained.
// A bounce or stop that is INFINITE, PARTIAL or PULSE fails (exit 1).
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const outPath = opt('--out');
const baselinePath = opt('--baseline');
const runs = args.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).runs);

export function judge(run) {
  const p = run.probe;
  const id = run.trial;
  const car = /truck/.test(id);
  const m = run.matrixInfo ?? {};
  if (!p) return { id, outcome: 'no-probe' };
  if (!p.contact) return { id, outcome: 'miss', vIn: p.vIn, pastMax: p.pastMax };
  const layer = run.layer ?? 0.3;
  const reach = car ? 1.0 : 2 * p.radius;
  const through = p.pastMax > layer + reach;
  const outcome = through ? 'through' : p.vOut < -0.1 * p.vIn ? 'bounce' : Math.abs(p.vOut) < 0.1 * p.vIn ? 'stopped' : 'slowed';
  const verdict = p.infiniteWall ? 'INFINITE' : p.partialHold ? 'PARTIAL' : p.underloaded ? 'PULSE' : p.touched ? 'held' : 'untouched';
  // A case with an expected outcome (wall-matrix.mjs `expect`) fails on any other.
  const missed = Array.isArray(run.expect) && !run.expect.includes(outcome);
  const fail = missed || ((outcome === 'bounce' || outcome === 'stopped') && (verdict === 'INFINITE' || verdict === 'PARTIAL' || verdict === 'PULSE'));
  return {
    id, outcome, verdict, fail, expected: run.expect,
    vIn: p.vIn, vOut: p.vOut, keptPct: 100 * Math.max(p.vOut, 0) / p.vIn, pastMax: p.pastMax, layer,
    peakMN: p.peakForceN / 1e6, hertzMN: (p.hertzPeakN ?? 0) / 1e6, hertzMs: p.hertzPulseMs, capacityMN: p.touchedCapacityN / 1e6, heldCapacityMN: p.heldCapacityN / 1e6,
    touched: p.touched, held: p.touchedHeldAnchored, types: p.touchedTypes,
    peakTick: p.peak?.tick, peakBroken: p.peak?.broken, peakAfterCorrection: p.peak?.brokenAfterCorrection, peakCorrections: p.peak?.corrections, peakConverged: p.peak?.converged,
    energyRatio: p.energyExcessRatio, debrisUp: p.debrisUpMax, impactorUpGain: (p.impactorUpMax ?? 0) - (p.impactorUpIn ?? 0),
    energyInjected: p.energyExcessRatio > 1.05,
    stopTicks: p.stopTicks, sceneBroken: Object.values(run.sceneBroken ?? {}).reduce((a, b) => a + b, 0), failedSteps: run.failedSteps, converged: run.converged,
  };
}

const rows = runs.map((r) => judge(r));
const base = baselinePath ? Object.fromEntries(JSON.parse(readFileSync(baselinePath, 'utf8')).rows.map((r) => [r.id, r])) : {};
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
console.log(`${'case'.padEnd(40)} ${'outcome'.padEnd(8)} ${'verdict'.padEnd(9)} ${'vIn'.padStart(6)} ${'vOut'.padStart(6)} ${'past'.padStart(6)} ${'peakMN'.padStart(7)} ${'capMN'.padStart(7)} ${'pulseMN'.padStart(7)} held/touched  peak tick: broken/after-corr/corr/conv  bonds  E/(lost+fall) debrisUp ballUp${baselinePath ? '  baseline' : ''}`);
for (const r of rows) {
  const b = base[r.id];
  console.log(`${r.id.padEnd(40)} ${String(r.outcome).padEnd(8)} ${String(r.verdict ?? '').padEnd(9)} ${f(r.vIn).padStart(6)} ${f(r.vOut).padStart(6)} ${f(r.pastMax, 2).padStart(6)} ${f(r.peakMN, 2).padStart(7)} ${f(r.capacityMN, 2).padStart(7)} ${f(r.hertzMN, 1).padStart(7)} ${String(r.held ?? '-').padStart(4)}/${String(r.touched ?? '-').padEnd(7)}  ${[r.peakBroken, r.peakAfterCorrection, r.peakCorrections, r.peakConverged].map((v) => v ?? '-').join('/').padEnd(14)} ${String(r.sceneBroken ?? '-').padStart(5)}  ${f(r.energyRatio, 2).padStart(5)} ${f(r.debrisUp, 1).padStart(5)} ${f(r.impactorUpGain, 1).padStart(5)}${r.energyInjected ? '  ENERGY' : ''}${r.fail ? '  FAIL' : ''}${b ? `  was ${b.outcome}/${b.verdict}` : ''}`);
}
const count = (k) => rows.reduce((m, r) => ({ ...m, [r[k]]: (m[r[k]] ?? 0) + 1 }), {});
console.log('outcomes', JSON.stringify(count('outcome')), 'verdicts', JSON.stringify(count('verdict')));
const failed = rows.filter((r) => r.fail);
console.log(failed.length ? `${failed.length} case(s) met an infinite wall: ${failed.map((r) => r.id).join(', ')}` : 'no case met an infinite wall');
if (outPath) writeFileSync(outPath, JSON.stringify({ rows, runs }, null, 1));
process.exitCode = failed.length ? 1 : 0;
