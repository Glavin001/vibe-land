#!/usr/bin/env node
// The impact comparison on the physics gates: repeated runs of each trial per
// arm (scripts/verify/impact-arms.sh), counted rather than averaged, because
// identical runs can end local or in a collapse.
//   node scripts/verify/impact-arms.mjs --pack PACK.json --meta META.json [--trials a,b]
//        [--truth scripts/verify/ground-truth] [--out OUT.json] ARM=DIR [ARM=DIR ...]
// Each DIR is one run: an acceptance output (DIR/testbed.json, VIBE_TESTBED_PROBE=1)
// or a test-bed report (.json). The same ARM given several times is its repeats.
//
// Per run, the gates (ground-truth.mjs gates()):
//   shots     through (KE above the path work gets >= 1 m past), energy (the
//             balance closes over the structure's window), held (no infinite
//             wall, no partial hold)
//   driving   enters, slows, held
// and the outcome:
//   local     no frame joint broke beyond the impactor's reach: its half-size
//             across its line plus the longer of the joint's two members (the
//             farthest a struck member, or one falling from it, can act)
//   collapse  frame joints broke beyond that reach: progressive failure
// (the test bed's house.frameBeyondReach). Per trial and arm the table counts
// local vs collapse and each gate's passes, and gives the spread (min-max) of
// the broken bonds, the frame joints beyond reach, the frame still anchored,
// the roof members down, the exit speed, the energy residual and the cost.
// The cached arm C (retired, a reference only) is shown where an entry exists.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { gates, currentKey, keyMismatch, compatibleWith } from './ground-truth.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const packPath = opt('--pack'), metaPath = opt('--meta'), outPath = opt('--out'), truthDir = opt('--truth');
const trialsWanted = opt('--trials', 'cannonball-framed-house,meteor-framed-house-roof,meteor-framed-house-upper,smallshots-framed-house,framed-house,framed-house-corner').split(',');
const inputs = args.map((a) => { const i = a.indexOf('='); return { arm: a.slice(0, i), dir: a.slice(i + 1) }; });
if (!packPath || !inputs.length) { console.error('usage: impact-arms.mjs --pack PACK --meta META [--trials a,b] [--truth DIR] ARM=DIR ...'); process.exit(2); }

const P = JSON.parse(readFileSync(packPath, 'utf8')).scenario;
// The house's frame (vehicle_testbed.rs FRAME_TYPES), for the cached C entries' reach count.
const FRAME = new Set(['foundation', 'stud', 'king-stud', 'jack-stud', 'cripple-stud', 'junction-stud', 'bottom-plate', 'top-plate',
  'header', 'sill-trimmer', 'rim-joist', 'ceiling-joist', 'floor-joist', 'subfloor', 'rafter', 'ridge-board', 'gable-frame']);
const member = (n) => { const s = P.nodeSizes?.[n]; return s ? Math.max(s.x, s.y, s.z) : 0; };

const loadRuns = ({ arm, dir }) => {
  const f = dir.endsWith('.json') ? dir : path.join(dir, 'testbed.json');
  if (!existsSync(f)) return [];
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const prov = path.join(path.dirname(f), 'provenance.log');
  const sdk = existsSync(prov) ? /\[provenance\] SDK (\S+): (\w+)/.exec(readFileSync(prov, 'utf8'))?.slice(1).join(' ') : null;
  return (Array.isArray(d) ? d : d.runs ?? []).filter((r) => r.car === 'monster').map((r) => ({ arm, dir, sdk, run: r }));
};
const all = inputs.flatMap(loadRuns);

/** One run's verdict: gates, outcome and the numbers the table spreads. */
function verdict(run) {
  const { s, checks } = gates(run);
  const h = run.house ?? {};
  const beyond = h.frameBeyondReach;
  return {
    checks, outcome: beyond == null ? '?' : beyond === 0 ? 'local' : 'collapse', beyond,
    broken: h.broken, frame: h.frameAnchoredFrac, roofDown: h.roofMembersDown, reach: h.reach,
    exit: run.probe?.vExit ?? null, energyPct: s?.window ? 100 * s.resid / s.ke : null,
    costMean: run.impactCost?.meanMs ?? null, costMax: run.impactCost?.maxMs ?? null, seconds: run.endedEarlyS ?? run.seconds ?? null,
  };
}

// The cached arm C: its key must match the SDK and packs of the runs compared,
// or the SDK be on the entry's compatible list (ground-truth.mjs compat).
const cached = {};
if (truthDir) {
  const physxRoot = process.env.PHYSX_ROOT ?? all.map((r) => /PHYSX_ROOT=(\S+)/.exec(existsSync(path.join(r.dir, 'environment.txt')) ? readFileSync(path.join(r.dir, 'environment.txt'), 'utf8') : '')?.[1]).find(Boolean);
  const now = currentKey(packPath, metaPath, { PHYSX_ROOT: physxRoot });
  for (const trial of trialsWanted) {
    const f = path.join(truthDir, `${trial}.json`);
    if (!existsSync(f)) continue;
    const t = JSON.parse(readFileSync(f, 'utf8'));
    const diff = keyMismatch(t.key, now, t.compatible);
    const admitted = now.sdkRevision !== t.key.sdkRevision && !diff.length ? compatibleWith(t, now.sdkRevision) : null;
    cached[trial] = { t, note: diff.length ? `keyed to another SDK or scene (${diff.join('; ')}): shown for reference only` : admitted ? `compatible: ${admitted.reason.slice(0, 80)}...` : 'same SDK and packs' };
  }
}
const cachedRow = (trial, reach) => {
  const c = cached[trial]; if (!c) return null;
  const { t } = c, h = t.house ?? {};
  let beyond = h.frameBeyondReach;
  if (beyond == null && reach != null && t.broken?.length) {
    beyond = t.broken.filter(([i, d]) => { const b = P.bonds[i]; return b && d != null && FRAME.has(P.nodeTypes[b.node0]) && FRAME.has(P.nodeTypes[b.node1]) && d > reach + Math.max(member(b.node0), member(b.node1)); }).length;
  }
  return { arm: 'C (cached, retired)', n: 1, local: beyond === 0 ? 1 : 0, collapse: beyond > 0 ? 1 : 0,
    gates: Object.fromEntries((t.gates ?? []).map((g) => [g.gate, `${g.pass ? 1 : 0}/1`])),
    broken: [t.broken?.length || h.broken], beyond: [beyond], frame: [h.frameAnchoredFrac], roofDown: [h.roofMembersDown], exit: [t.exitSpeed],
    energyPct: [t.metrics?.energy ? 100 * t.metrics.energy.residJ / t.metrics.keJ : null], costMean: [t.cost?.meanMs], costMax: [t.cost?.maxMs], seconds: [null], note: c.note };
};

const rows = [];
for (const trial of trialsWanted) {
  const runs = all.filter((r) => r.run.trial === trial);
  const reach = runs.map((r) => r.run.house?.reach).find((x) => x != null);
  const c = cachedRow(trial, reach); if (c) rows.push({ trial, ...c });
  for (const arm of [...new Set(inputs.map((i) => i.arm))]) {
    const vs = runs.filter((r) => r.arm === arm).map((r) => verdict(r.run));
    if (!vs.length) { rows.push({ trial, arm, n: 0 }); continue; }
    const gateNames = [...new Set(vs.flatMap((v) => v.checks.map((g) => g.gate)))];
    rows.push({ trial, arm, n: vs.length,
      local: vs.filter((v) => v.outcome === 'local').length, collapse: vs.filter((v) => v.outcome === 'collapse').length,
      gates: Object.fromEntries(gateNames.map((g) => [g, `${vs.filter((v) => v.checks.find((x) => x.gate === g)?.pass).length}/${vs.length}`])),
      ...Object.fromEntries(['broken', 'beyond', 'frame', 'roofDown', 'exit', 'energyPct', 'costMean', 'costMax', 'seconds'].map((k) => [k, vs.map((v) => v[k])])),
      sdk: [...new Set(runs.filter((r) => r.arm === arm).map((r) => r.sdk))].join(', ') });
  }
}

const num = (x, d) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(d));
const spread = (xs, d = 0) => { const v = (xs ?? []).filter((x) => x != null); if (!v.length) return '-'; const lo = Math.min(...v), hi = Math.max(...v); return lo === hi ? num(lo, d) : `${num(lo, d)}-${num(hi, d)}`; };
const cols = [
  ['trial', (r) => r.trial.replace('-framed-house', '').replace('framed-house', 'truck')], ['arm', (r) => r.arm], ['n', (r) => String(r.n)],
  ['local/collapse', (r) => !r.n ? 'no runs' : r.local + r.collapse ? `${r.local}/${r.collapse}` : '?'],
  ['gates passed', (r) => r.gates ? Object.entries(r.gates).map(([g, v]) => `${g} ${v}`).join(', ') : ''],
  ['broken', (r) => spread(r.broken)], ['frame beyond reach', (r) => spread(r.beyond)], ['frame anchored', (r) => spread(r.frame, 2)],
  ['roof down', (r) => spread(r.roofDown)], ['exit m/s', (r) => spread(r.exit, 1)], ['energy %KE', (r) => spread(r.energyPct, 1)],
  ['ms/impact tick mean (max)', (r) => r.costMean ? `${spread(r.costMean)} (${spread(r.costMax)})` : '-'], ['s run', (r) => spread(r.seconds, 1)],
];
const table = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))];
const w = cols.map((_, i) => Math.max(...table.map((t) => String(t[i]).length)));
for (const [k, t] of table.entries()) {
  console.log(t.map((x, i) => String(x).padEnd(w[i])).join('  '));
  if (k === 0) console.log(w.map((n) => '-'.repeat(n)).join('  '));
}
for (const r of rows) if (r.note) console.log(`[arms] ${r.trial}: cached C ${r.note}`);
const sdks = [...new Set(all.map((r) => r.sdk).filter(Boolean))];
if (sdks.length > 1) console.log(`[arms] WARNING: runs on more than one SDK: ${sdks.join('; ')}`);
if (outPath) writeFileSync(outPath, JSON.stringify({ rows }, null, 1));
