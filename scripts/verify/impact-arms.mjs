#!/usr/bin/env node
// The impact-arm comparison: the same shots on each arm of the high profile,
// side by side, against arm C (the ADMM impact solve at its correctness budget).
//   node scripts/verify/impact-arms.mjs --pack PACK.json --meta META.json ARM=DIR ...
// Each DIR is an acceptance output (scripts/verify/acceptance.sh high-ARM DIR):
// its testbed.json (VIBE_TESTBED_PROBE=1) and environment.txt; or a test-bed
// report (.json), e.g. the scenario matrix's scenarios-high-ARM/lab.json with
// --meta scenarios-high-ARM/lab.meta.json and --trials naming its cases. Per shot and arm:
//   past       m past the point struck (pass-through when KE > path work: shot-physics.mjs)
//   broken     house bonds broken; Jaccard of that set against arm C's
//   locality   p90 distance of the broken bonds from the shot line, and the share
//              beyond 4 m of it (the pack's bond centroids)
//   energy     unaccounted over the structure's window, % of KE (closes within
//              -10%..contact+10%)
//   momentum   impulse delivered to the structure, kg m/s (probe dp)
//   cost       stage step ms per tick over the window: mean / max
// Writes --out JSON when given. The reference arm is --ref (default oracle).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { shotPhysics, jaccard } from './shot-physics.mjs';
import { currentKey, keyMismatch } from './ground-truth.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const packPath = opt('--pack'), metaPath = opt('--meta'), outPath = opt('--out'), truthDir = opt('--truth');
let ref = opt('--ref', 'oracle');
const trialsWanted = opt('--trials', 'cannonball-framed-house,meteor-framed-house,meteor-framed-house-roof,meteor-framed-house-upper').split(',');
const arms = args.map((a) => { const [name, dir] = a.split('='); return { name, dir }; });
if (!packPath || !arms.length) { console.error('usage: impact-arms.mjs --pack PACK --meta META [--ref oracle] [--trials a,b] ARM=DIR ...'); process.exit(2); }

const P = JSON.parse(readFileSync(packPath, 'utf8'));
const bonds = P.scenario.bonds;
const meta = metaPath && existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
const trialsMeta = meta?.trials ?? meta?.TRIALS ?? [];
// The shot line: through the target, along -(sin b, slope, cos b) (vehicle_testbed.rs shot start).
const line = (id) => {
  const t = trialsMeta.find((x) => x.id === id)?.attack;
  if (!t?.target) return null;
  const b = (t.from ?? 0) * Math.PI / 180, s = t.slope ?? 0.8;
  const d = [-Math.sin(b), -s, -Math.cos(b)], n = Math.hypot(...d);
  return { p: t.target, d: d.map((x) => x / n) };
};
const distance = (L, c) => {
  const v = [c.x - L.p[0], c.y - L.p[1], c.z - L.p[2]], along = v[0] * L.d[0] + v[1] * L.d[1] + v[2] * L.d[2];
  return Math.hypot(v[0] - along * L.d[0], v[1] - along * L.d[1], v[2] - along * L.d[2]);
};
// Same place: two broken joints are at the same place when their centroids lie
// within the larger of their contact sizes (sqrt of the bond area) -- the
// joint's own scale. The score is the F1 of matching each set into the other.
const samePlace = (a, b) => {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const near = (i, j) => { const p = bonds[i], q = bonds[j]; if (!p || !q) return false;
    const r = Math.max(Math.sqrt(p.area), Math.sqrt(q.area));
    return Math.hypot(p.centroid.x - q.centroid.x, p.centroid.y - q.centroid.y, p.centroid.z - q.centroid.z) <= r; };
  const hit = (xs, ys) => xs.filter((i) => ys.some((j) => near(i, j))).length / xs.length;
  const precision = hit(a, b), recall = hit(b, a);
  return precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
};
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const load = (arm) => {
  // A directory (acceptance output) or a test-bed report itself (the scenario
  // matrix's target/verify/scenarios-high-ARM/lab.json).
  const f = arm.dir.endsWith('.json') ? arm.dir : path.join(arm.dir, 'testbed.json');
  const runs = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  const envf = path.join(path.dirname(f), 'environment.txt');
  const env = existsSync(envf) ? readFileSync(envf, 'utf8') : '';
  return { ...arm, envText: env, runs: Array.isArray(runs) ? runs : runs?.runs ?? runs?.results ?? null, missing: /missing=(\S.*)$/m.exec(env)?.[1] ?? '?' };
};
const loaded = arms.map(load);
// The cached ground truth (scripts/verify/ground-truth, ground-truth.mjs record):
// arm C's runs, used as the reference instead of rerunning C. Its key must
// match the SDK and packs of the runs compared (VERIFY_ALLOW_TRUTH_MISMATCH=1
// compares anyway, and says so).
if (truthDir) {
  const physxRoot = process.env.PHYSX_ROOT ?? loaded.map((a) => /PHYSX_ROOT=(\S+)/.exec(a.envText ?? '')?.[1]).find(Boolean);
  const now = currentKey(packPath, metaPath, { PHYSX_ROOT: physxRoot });
  const runs = [];
  for (const trial of trialsWanted) {
    const f = path.join(truthDir, `${trial}.json`);
    if (!existsSync(f)) { console.log(`[arms] no ground truth for ${trial} (${f})`); continue; }
    const t = JSON.parse(readFileSync(f, 'utf8'));
    const diff = keyMismatch(t.key, now);
    if (diff.length) {
      console.log(`[arms] ground truth for ${trial} is keyed to another SDK or scene: ${diff.join('; ')}`);
      if (process.env.VERIFY_ALLOW_TRUTH_MISMATCH !== '1') { console.log('[arms] refusing to compare (VERIFY_ALLOW_TRUTH_MISMATCH=1 compares anyway)'); process.exit(1); }
    }
    runs.push({ trial, car: 'monster', truthOnly: t });
  }
  // Each arm compared must have run on the cache's SDK.
  for (const a of loaded) {
    const f = a.dir.endsWith('.json') ? path.join(path.dirname(a.dir), 'provenance.log') : path.join(a.dir, 'provenance.log');
    const ran = existsSync(f) && /\[provenance\] SDK (\S+): (\w+)/.exec(readFileSync(f, 'utf8'));
    if (ran && now.sdkRevision && !now.sdkRevision.startsWith(ran[2])) console.log(`[arms] WARNING: arm ${a.name} ran on ${ran[1]} ${ran[2]}, the ground truth on ${now.sdk} ${now.sdkRevision.slice(0, 9)}: not comparable`);
  }
  loaded.unshift({ name: 'C cached', dir: truthDir, runs, missing: 'none' });
  ref = 'C cached';
}
const refArm = loaded.find((a) => a.name === ref);
const rows = [];
for (const trial of trialsWanted) {
  const L = line(trial);
  const refRun = refArm?.runs?.find((r) => r.trial === trial && r.car === 'monster');
  const refBroken = refRun?.truthOnly ? refRun.truthOnly.broken.map((x) => x[0]) : refRun?.physics?.brokenIds ?? null;
  for (const a of loaded) {
    const r = a.runs?.find((x) => x.trial === trial && x.car === 'monster');
    if (r?.truthOnly) {
      // A cached ground-truth trial (ground-truth.mjs record): its metrics as recorded.
      const t = r.truthOnly, m = t.metrics, ids = t.broken.map((x) => x[0]), ds = t.broken.map((x) => x[1]).filter((x) => x != null);
      if (!m) { rows.push({ trial, arm: a.name, status: 'cached driving trial (no shot terms)' }); continue; }
      const g = (k) => t.gates.find((x) => x.gate === k);
      rows.push({ trial, arm: a.name, missing: 'none', past: m.past, mustPass: m.keJ > m.pathJ, passed: g('through')?.pass, keMJ: m.keJ / 1e6, pathMJ: m.pathJ / 1e6,
        broken: ids.length, jaccard: refBroken ? jaccard(ids, refBroken) : null, samePlace: refBroken ? samePlace(ids, refBroken) : null,
        p90M: quantile(ds, 0.9), farShare: ds.length ? ds.filter((x) => x > 4).length / ds.length : null,
        residPct: m.energy ? 100 * m.energy.residJ / m.keJ : null, closes: g('energy')?.pass ?? true, momentum: m.momentumLost, wall: g('held')?.measured,
        costMean: t.cost?.meanMs ?? null, costMax: t.cost?.maxMs ?? null, costTicks: t.cost?.ticks ?? null });
      continue;
    }
    const s = shotPhysics(r);
    if (!s) { rows.push({ trial, arm: a.name, status: !a.runs ? 'no testbed.json' : !r ? 'trial missing' : 'no probe/contact' }); continue; }
    const L2 = refRun?.truthOnly?.line ?? L;
    const ds = L2 ? s.brokenIds.map((i) => bonds[i] && distance(L2, bonds[i].centroid)).filter((x) => x != null) : [];
    rows.push({
      trial, arm: a.name, missing: a.missing,
      past: s.past, mustPass: s.mustPass, passed: s.passed, keMJ: s.ke / 1e6, pathMJ: s.pathD / 1e6,
      broken: s.brokenIds.length, jaccard: refBroken ? jaccard(s.brokenIds, refBroken) : null, samePlace: refBroken ? samePlace(s.brokenIds, refBroken) : null,
      p90M: quantile(ds, 0.9), farShare: ds.length ? ds.filter((x) => x > 4).length / ds.length : null,
      residPct: 100 * s.resid / s.ke, closes: s.closes, windowEnd: s.window?.end ?? 'no window', afterWindowMJ: s.afterWindow / 1e6,
      momentum: s.momentumLost, wall: s.infiniteWall ? 'INFINITE WALL' : s.partialHold ? 'partial hold' : 'ok',
      costMean: r.impactCost?.meanMs ?? null, costMax: r.impactCost?.maxMs ?? null, costTicks: r.impactCost?.ticks ?? null,
    });
  }
}
const f = (v, d = 2) => (v == null || Number.isNaN(v) ? '-' : typeof v === 'number' ? v.toFixed(d) : String(v));
const cols = [
  ['shot', (r) => r.trial.replace('-framed-house', '')], ['arm', (r) => r.arm],
  ['past m', (r) => r.status ?? `${f(r.past, 1)}${r.mustPass ? (r.passed ? '' : ' FAIL') : ''}`],
  ['KE/path MJ', (r) => r.status ? '' : `${f(r.keMJ, 1)}/${f(r.pathMJ, 1)}`],
  ['broken', (r) => f(r.broken, 0)], [`J vs ${ref}`, (r) => f(r.jaccard)], ['same place', (r) => f(r.samePlace)],
  ['p90 m', (r) => f(r.p90M, 1)], ['>4 m', (r) => r.farShare == null ? '-' : `${f(100 * r.farShare, 0)}%`],
  ['energy %KE', (r) => r.status ? '' : r.residPct == null ? 'n/a' : `${f(r.residPct, 1)}${r.closes ? '' : ' FAIL'}`],
  ['momentum kg m/s', (r) => f(r.momentum, 0)], ['held', (r) => r.wall ?? ''],
  ['ms/tick mean/max', (r) => r.costMean == null ? '-' : `${f(r.costMean, 1)}/${f(r.costMax, 0)}`],
];
const table = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => c[1](r)))];
const w = cols.map((_, i) => Math.max(...table.map((t) => String(t[i]).length)));
for (const [k, t] of table.entries()) {
  console.log(t.map((x, i) => String(x).padEnd(w[i])).join('  '));
  if (k === 0) console.log(w.map((n) => '-'.repeat(n)).join('  '));
}
for (const a of loaded) if (a.missing && a.missing !== 'none' && a.missing !== '?') console.log(`[arms] ${a.name}: not exercised on this SDK: ${a.missing}`);
if (outPath) writeFileSync(outPath, JSON.stringify({ ref, rows }, null, 1));
