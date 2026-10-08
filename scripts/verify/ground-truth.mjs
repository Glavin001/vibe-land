#!/usr/bin/env node
// Ground truth for the impact arms: arm C (the ADMM impact solve at its
// correctness budget) recorded once per trial, so faster arms are compared
// against the cache instead of rerunning C.
//
//   node scripts/verify/ground-truth.mjs record --run DIR --pack PACK --meta META [--trials a,b] [--out DIR] [--raw DIR]
//       Judge C's runs (DIR/testbed.json, DIR/environment.txt) against the owner's
//       physical gates, write every trial to --raw (default target/verify/ground-truth)
//       and the passing ones to --out (default scripts/verify/ground-truth/<trial>.json).
//   node scripts/verify/ground-truth.mjs key --pack PACK --meta META
//       The current key (SDK revision, pack and meta hashes).
//
// The gates (docs/verification/README.md, "Ground truth"):
//   through   a shot whose KE exceeds its path work gets >= 1 m past the point struck
//             (the owner: the cannonball and the meteor go through the building)
//   energy    shots: the balance closes over the structure's window
//   held      nothing holds past its capacity (no infinite wall, no partial hold)
// A driving trial (the truck into the house; no shot, so the test bed records
// the probe but no energy terms or bond ids):
//   enters    the car's middle gets past the face it first struck
//   slows     it leaves slower than it came (momentum went into the structure)
//   held      as above
// Locality is recorded (each broken bond's distance from the impactor's line,
// the frame still anchored, the roof members down), not gated: the physics
// criterion for it is that each break is its own verdict, which the held gate
// and the at-rest gate cover.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shotPhysics } from './shot-physics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const round = (x, d = 3) => (typeof x === 'number' ? Number(x.toFixed(d)) : x);

/** The key a cached result is valid for: the SDK it ran on and the scene it ran in. */
export function currentKey(packPath, metaPath, env = process.env) {
  const art = env.PHYSX_ROOT && path.join(env.PHYSX_ROOT, 'sdk-artifacts.json');
  const sdk = art && existsSync(art) ? JSON.parse(readFileSync(art, 'utf8')) : {};
  return {
    sdk: env.PHYSX_ROOT ? path.basename(env.PHYSX_ROOT) : null,
    sdkRevision: sdk.source_revision ?? null, sdkDirty: sdk.source_dirty ?? null,
    pack: path.basename(packPath), packSha256: sha(packPath),
    metaSha256: metaPath && existsSync(metaPath) ? sha(metaPath) : null,
  };
}
/** Differences between a cached key and the current one ([] when it matches). */
export function keyMismatch(cached, current) {
  return ['sdkRevision', 'packSha256', 'metaSha256'].filter((k) => cached?.[k] !== current[k])
    .map((k) => `${k}: cached ${String(cached?.[k]).slice(0, 12)}, now ${String(current[k]).slice(0, 12)}`);
}

/** The shot's line: through the target along -(sin b, slope, cos b) (vehicle_testbed.rs). */
export function shotLine(trialMeta) {
  const t = trialMeta?.attack;
  if (!t?.target) return null;
  const b = (t.from ?? 0) * Math.PI / 180, s = t.slope ?? 0.8;
  const d = [-Math.sin(b), -s, -Math.cos(b)], n = Math.hypot(...d);
  return { p: t.target, d: d.map((x) => x / n) };
}
/** A run's line: the shot's, else the impactor's own path (first to last probe sample). */
export function impactLine(run, trialMeta) {
  const L = shotLine(trialMeta);
  if (L) return L;
  const path_ = run?.impactorPath;
  if (!path_?.length) return null;
  const a = path_[0], b = path_[path_.length - 1], d = [b[1] - a[1], 0, b[3] - a[3]], n = Math.hypot(...d) || 1;
  return { p: [a[1], a[2], a[3]], d: d.map((x) => x / n) };
}
export function distanceFromLine(L, c) {
  const v = [c.x - L.p[0], c.y - L.p[1], c.z - L.p[2]], along = v[0] * L.d[0] + v[1] * L.d[1] + v[2] * L.d[2];
  return Math.hypot(v[0] - along * L.d[0], v[1] - along * L.d[1], v[2] - along * L.d[2]);
}

/** A driving trial's gates (no shot): the probe's speeds and holds. */
export function carGates(run) {
  const pr = run.probe, face = run.house?.impact?.[2];
  const enters = run.maxZ != null && face != null ? run.maxZ - face : null;
  return [
    { gate: 'enters', pass: enters != null && enters >= 0, measured: enters == null ? 'not recorded' : `middle ${enters.toFixed(2)} m past the face struck (z ${face.toFixed(2)})` },
    { gate: 'slows', pass: pr.vOut < pr.vIn && pr.momentumLost > 0, measured: `${pr.vIn.toFixed(1)} -> ${pr.vOut.toFixed(1)} m/s, ${(pr.momentumLost / 1e3).toFixed(1)}e3 kg m/s into the structure` },
    { gate: 'held', pass: !pr.infiniteWall && !pr.partialHold, measured: pr.infiniteWall ? 'infinite wall' : pr.partialHold ? 'partial hold' : 'ok' },
  ];
}

/** The owner's physical gates on one run. */
export function gates(run) {
  const s = shotPhysics(run);
  const shot = run?.attack?.kind === 'shot';
  if (!s && run?.probe?.contact && !run.attack) return { s: null, shot: false, car: true, checks: carGates(run) };
  if (!s) return { s: null, shot, checks: [{ gate: 'recorded', pass: false, measured: !run ? 'missing' : 'no probe or no contact' }] };
  const checks = [
    { gate: 'through', pass: s.passed, measured: `KE ${(s.ke / 1e6).toFixed(2)} MJ vs path ${(s.pathD / 1e6).toFixed(2)} MJ; ${s.past.toFixed(2)} m past` },
    { gate: 'held', pass: !s.infiniteWall && !s.partialHold, measured: s.infiniteWall ? 'infinite wall' : s.partialHold ? 'partial hold' : 'ok' },
  ];
  if (shot) checks.splice(1, 0, { gate: 'energy', pass: s.closes, measured: `unaccounted ${(100 * s.resid / s.ke).toFixed(1)}% of KE over ${s.window ? `the window (${s.window.end})` : 'the run (no window)'}` });
  return { s, shot, checks };
}

async function record(argv) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const runDir = opt('--run'), packPath = opt('--pack'), metaPath = opt('--meta');
  const out = opt('--out', path.join(ROOT, 'scripts/verify/ground-truth')), raw = opt('--raw', path.join(ROOT, 'target/verify/ground-truth'));
  const runs = JSON.parse(readFileSync(path.join(runDir, 'testbed.json'), 'utf8'));
  const list = Array.isArray(runs) ? runs : runs.runs ?? runs.results;
  const env = existsSync(path.join(runDir, 'environment.txt')) ? readFileSync(path.join(runDir, 'environment.txt'), 'utf8') : '';
  const flags = Object.fromEntries(env.split('\n').filter((l) => /^(VIBE_|PX_|TOWN_KIT)/.test(l)).map((l) => l.split('=')));
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const bonds = JSON.parse(readFileSync(packPath, 'utf8')).scenario.bonds;
  // The key is what the run ran on: its provenance log names the SDK revision
  // (checked against the SDK installed now), and the packs must not be newer
  // than the run.
  const key = { ...currentKey(packPath, metaPath), arm: flags.VIBE_FIDELITY_PROFILE ?? 'high-oracle', flags };
  const prov = existsSync(path.join(runDir, 'provenance.log')) ? readFileSync(path.join(runDir, 'provenance.log'), 'utf8') : '';
  const ran = /\[provenance\] SDK (\S+): (\w+)/.exec(prov);
  if (!ran || !String(key.sdkRevision).startsWith(ran[2]) || ran[1] !== key.sdk) {
    console.error(`[ground-truth] the run's SDK (${ran ? `${ran[1]} ${ran[2]}` : 'unrecorded'}) is not the SDK installed now (${key.sdk} ${String(key.sdkRevision).slice(0, 9)}): not recording`);
    process.exit(1);
  }
  const { statSync } = await import('node:fs');
  if (statSync(packPath).mtimeMs > statSync(path.join(runDir, 'testbed.json')).mtimeMs) {
    console.error(`[ground-truth] ${packPath} is newer than the run: not recording`); process.exit(1);
  }
  const trials = (opt('--trials') ?? list.map((r) => r.trial).join(',')).split(',');
  mkdirSync(out, { recursive: true }); mkdirSync(raw, { recursive: true });
  const verdicts = [];
  for (const trial of trials) {
    const run = list.find((r) => r.trial === trial && r.car === 'monster');
    const tm = meta.trials.find((t) => t.id === trial);
    const { s, shot, checks } = gates(run);
    // The gates read the probe's mass: a `shots` run recorded before the test
    // bed took each shot's own mass (it fell back to the cannonball's) is not
    // ground truth, whatever its gates say.
    const shotMass = tm?.attack?.kind === 'shots' ? tm.attack.shots?.[tm.attack.shots.length - 1]?.mass ?? 100 : null;
    if (shotMass != null && run?.probe && Math.abs(run.probe.mass - shotMass) > 1e-3 * shotMass)
      checks.push({ gate: 'recorded', pass: false, measured: `probe mass ${run.probe.mass} kg, the shot's ${shotMass} kg (a test bed from before the per-shot mass)` });
    const pass = checks.every((c) => c.pass);
    verdicts.push({ trial, pass, checks });
    if (!run) continue;
    writeFileSync(path.join(raw, `${trial}.run.json`), JSON.stringify(run));
    const L = impactLine(run, tm);
    const broken = (s?.brokenIds ?? []).map((i) => [i, bonds[i] && L ? round(distanceFromLine(L, bonds[i].centroid), 2) : null]);
    const truth = {
      trial, key, recorded: new Date().toISOString(), truth: pass, gates: checks,
      line: L && { p: L.p.map((x) => round(x)), d: L.d.map((x) => round(x, 4)) },
      broken, gone: s?.goneIds ?? [],
      metrics: s && {
        keJ: round(s.ke, 0), pathJ: round(s.pathD, 0), past: round(s.past), momentumLost: round(s.momentumLost, 0),
        peakForceN: round(s.peakForceN, 0), heldCapacityN: round(s.heldCapacityN, 0),
        energy: shot ? { lostJ: round(s.lost, 0), dropJ: round(s.drop, 0), fractureJ: round(s.fracture, 0), crushJ: round(s.crush, 0), fragmentsKeJ: round(s.fragKe, 0), peReleasedJ: round(s.pe, 0), residJ: round(s.resid, 0), contactJ: round(s.contact, 0), afterWindowJ: round(s.afterWindow, 0), window: s.window } : null,
      },
      // Driving trials: the probe's numbers (no energy terms or bond ids recorded).
      car: !s && run.probe ? { massKg: run.probe.mass, vIn: round(run.probe.vIn), vOut: round(run.probe.vOut), vExit: round(run.probe.vExit),
        momentumLost: round(run.probe.momentumLost, 0), keLostJ: round(run.probe.energyLost, 0), maxZ: round(run.maxZ), carBondsBroken: run.bondsBroken } : null,
      // Locality, recorded not gated: the house's own summary (vehicle_testbed.rs).
      house: run.house && (({ lineDistances, ...h }) => ({ ...h, lineDistanceMedian: lineDistances?.length ? [...lineDistances].sort((a, b) => a - b)[lineDistances.length >> 1] : null }))(run.house),
      exitSpeed: run.probe ? round(run.probe.vExit) : null,
      cost: run.impactCost ?? null,
      // [tick, x, y, z, vx, vy, vz] at the probe's ticks.
      path: (run.impactorPath ?? []).map((r) => r.map((x, k) => round(x, k === 0 ? 0 : 3))),
    };
    writeFileSync(path.join(raw, `${trial}.json`), JSON.stringify(truth, null, 1));
    if (pass) writeFileSync(path.join(out, `${trial}.json`), JSON.stringify(truth));
  }
  for (const v of verdicts) console.log(`${v.pass ? 'TRUTH' : 'FAILS'}  ${v.trial.padEnd(28)} ${v.checks.map((c) => `${c.gate} ${c.pass ? 'ok' : 'FAIL'} (${c.measured})`).join('; ')}`);
  console.log(`[ground-truth] key: ${key.sdk} ${String(key.sdkRevision).slice(0, 9)}, pack ${key.packSha256.slice(0, 12)}; ${verdicts.filter((v) => v.pass).length} of ${verdicts.length} trials cached in ${path.relative(ROOT, out)}`);
  writeFileSync(path.join(raw, 'verdicts.json'), JSON.stringify({ key, verdicts }, null, 1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'record') await record(rest);
  else if (cmd === 'key') { const o = (k) => rest[rest.indexOf(k) + 1]; console.log(JSON.stringify(currentKey(o('--pack'), o('--meta')), null, 1)); }
  else { console.error('usage: ground-truth.mjs record|key ...'); process.exit(2); }
}
