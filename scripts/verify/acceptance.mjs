#!/usr/bin/env node
// Acceptance scenarios: every behaviour the owner asked for this week, as data,
// judged from the existing harnesses' outputs. scripts/verify/acceptance.sh runs
// the harnesses for an engine profile; this file says what each scenario is,
// which harness output it reads and what passes.
//
//   node scripts/verify/acceptance.mjs list              the scenarios as JSON (for other suites)
//   node scripts/verify/acceptance.mjs judge PROFILE DIR  read DIR's harness outputs, print the
//                                                        table, append rows to DIR/acceptance.jsonl
//
// Criteria marked `proposed` are numbers this suite introduces where no harness
// gated the behaviour before (locality, roof and frame holding, crushes only
// where hit): they are acceptance thresholds for the owner to confirm, stated
// with the reasoning, never tuned to make a run pass.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const testbedRuns = (dir) => {
  const f = path.join(dir, 'testbed.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).runs : null;
};
const testbedVerdict = (dir) => {
  const f = path.join(dir, 'testbed-verdict.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).cars.flatMap((c) => c.rows.map((r) => ({ ...r, car: c.car }))) : null;
};
const qualify = (dir, name) => {
  const f = path.join(dir, `qualify-${name}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const status = (dir, name) => {
  const f = path.join(dir, `${name}.status`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
};
// The projectiles as the server fires them: the cannonball 10,650 kg at 60 m/s
// (server/src/city.rs city_ball_mass_kg, city_ball_speed_ms); the meteor a 2 m
// radius sphere of 3,300 kg/m3 (110.6 t) at 140 m/s (server/src/meteor.rs).
const SHOT_KE = { cannonball: 0.5 * 10650 * 60 * 60, meteor: 0.5 * (3300 * 4 / 3 * Math.PI * 8) * 140 * 140 };
// A shot that stops short of getting through has lost all its kinetic energy
// inside the house. The joints and crushed chunks are the only dissipation the
// engine models there (plus contact), and the test bed reports only their count:
// a stop with a few dozen joints broken is energy vanishing (an infinite wall).
const energyCheck = (r, kind, need) => {
  const past = r?.attack?.pastTarget ?? 0;
  const ke = SHOT_KE[kind];
  const h = r?.house;
  return { check: `${kind}: no energy vanishes (gets through, or the house absorbs it)`, measured: r ? (past >= need ? `through (${fmt(past)} m past)` : `stopped ${fmt(past)} m past the face: ${(ke / 1e6).toFixed(1)} MJ lost to ${h?.broken ?? '?'} joints broken, ${h?.crushedChunks ?? '?'} crushed`) : 'missing', threshold: `past >= ${need} m`, pass: !!r && past >= need };
};
const run = (runs, trial) => runs?.find((r) => r.trial === trial && r.car === 'monster');
const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '-' : typeof v === 'number' ? v.toFixed(d) : String(v));

// The house probe's own definitions (server/src/vehicle_testbed.rs HouseProbe):
// a roof member is "down" when it has dropped > 0.5 m; the frame fraction is
// the share of frame chunks (studs, plates, joists, rafters) still on the
// anchored body.
const ROOF_DOWN_ALLOWED = 0; // proposed: the roof holds = no roof member dropped > 0.5 m
const ROOF_DROP_MEAN = 0.2; // the roof's members' mean drop, m (owner, 2026-10-07)
// Bonds broken in the veneer house (3,084 bonds), as a share, from the impact
// oracle's bands (structures/town-kit/scripts/impact-study.py, impact-e-replay):
// a cannonball ~4-10%, the truck ~7-12%, a meteor ~16% (about 490 of 3,084).
const BAND = { ball: [0.04, 0.10], truck: [0.07, 0.12], meteor: [0.12, 0.20], small: [0, 0.01] };
const FRAME_KEPT = 0.8; // proposed: a 2.5 m wide truck path through a ~10 m house
//                         removes the studs it hits (front and back wall, ~2 x 25%
//                         of those walls, ~10-15% of the frame); 80% kept is "the
//                         frame holds" with that allowance, not a collapse
const FAR = '8m+'; // proposed: a cannonball's damage stays within 8 m of where it hit

function houseChecks(r, { through, local, band }) {
  const h = r?.house;
  if (!r) return [{ check: 'trial ran', measured: 'missing', threshold: 'ran', pass: false }];
  const out = [];
  if (through) out.push(through(r));
  if (band) {
    const f = h ? h.broken / h.bonds : NaN;
    out.push({ check: 'bonds broken in the house (share, oracle band)', measured: h ? `${h.broken} of ${h.bonds} (${(100 * f).toFixed(1)}%)` : '-', threshold: `${Math.round(100 * band[0])}-${Math.round(100 * band[1])}%`, pass: f >= band[0] && f <= band[1] });
  }
  out.push({ check: 'roof stays up (mean drop of its members)', measured: h ? `${fmt(h.roofDropMean)} m` : '-', threshold: `< ${ROOF_DROP_MEAN} m`, pass: !!h && h.roofDropMean < ROOF_DROP_MEAN });
  out.push({ check: 'roof holds (members dropped > 0.5 m)', measured: h ? `${h.roofMembersDown} of ${h.roofMembers}` : '-', threshold: `<= ${ROOF_DOWN_ALLOWED} (proposed)`, pass: !!h && h.roofMembersDown <= ROOF_DOWN_ALLOWED });
  out.push({ check: 'frame holds (frame chunks still anchored)', measured: h ? fmt(h.frameAnchoredFrac) : '-', threshold: `>= ${FRAME_KEPT} (proposed)`, pass: !!h && h.frameAnchoredFrac >= FRAME_KEPT });
  if (local) out.push({ check: 'damage local (bonds broken > 8 m from the hit)', measured: h ? `${h.byDistance?.[FAR]} of ${h.broken}` : '-', threshold: '0 (proposed)', pass: !!h && (h.byDistance?.[FAR] ?? 1) === 0 });
  out.push({ check: 'every step completed', measured: r.failedSteps, threshold: '0', pass: r.failedSteps === 0 });
  return out;
}

export const SCENARIOS = [
  {
    id: 'packs-stand-at-rest',
    behaviour: 'Every pack the suite builds stands at rest: no bond breaks from tick 0 (settle included), before anything hits it',
    harness: { kind: 'qualify', packs: ['lab', 'veneer (as built and framed)', 'town'] },
    judge(dir) {
      const out = [];
      for (const q of ['lab', 'veneer', 'town']) {
        const res = qualify(dir, q)?.filter((r) => !/no-(ground-)?front-studs/.test(r.structure) && r.verdict !== 'FREE');
        if (!res) { out.push({ check: `${q}: structures with a bond broken at rest`, measured: 'missing', threshold: '0', pass: false }); continue; }
        const bad = res.filter((r) => r.broken_pct == null || r.broken_pct > 0);
        out.push({ check: `${q}: structures with a bond broken at rest`, measured: `${bad.length} of ${res.length}${bad.length ? ': ' + bad.slice(0, 5).map((r) => `${r.structure} ${r.broken_pct == null ? r.verdict : r.broken_pct.toFixed(2) + '%'}`).join(', ') : ''}`, threshold: '0 (any bond, from tick 0)', pass: bad.length === 0 });
      }
      const rest = run(testbedRuns(dir), 'rest');
      const scene = rest ? Object.values(rest.sceneBroken ?? {}).reduce((a, b) => a + b, 0) : null;
      out.push({ check: 'vehicle lab rest trial: scene bonds broken', measured: scene ?? 'missing', threshold: '0', pass: scene === 0 });
      return out;
    },
  },
  {
    id: 'truck-through-house',
    behaviour: 'The monster truck drives into a house, through the front wall and through the house; damage is local, the frame and the roof hold',
    harness: { kind: 'testbed', build: 'monster', trials: ['framed-house', 'house'] },
    judge(dir, profile) {
      const runs = testbedRuns(dir);
      const framed = run(runs, 'framed-house'), old = run(runs, 'house');
      return [
        ...houseChecks(framed, { band: BAND.truck, through: (r) => ({ check: 'veneer house: through the front wall (m past the brick face z 20.1)', measured: fmt(r.maxZ - 20.1), threshold: '>= 0', pass: r.maxZ - 20.1 >= 0 }) }).map((c) => ({ ...c, check: `veneer house: ${c.check.replace('veneer house: ', '')}` })),
        // High fidelity (impact capacity): the truck goes through the house.
        ...(profile === 'high' ? [{ check: 'veneer house: through the house (m past the back face z 27.9)', measured: framed ? fmt(framed.maxZ - 27.9) : 'missing', threshold: '>= 0 (high)', pass: !!framed && framed.maxZ - 27.9 >= 0 }] : []),
        { check: 'one-storey house: through the house (m past the back wall z 27.9)', measured: old ? fmt(old.maxZ - 27.9) : 'missing', threshold: '>= 0', pass: !!old && old.maxZ - 27.9 >= 0 },
      ];
    },
  },
  {
    id: 'shots-through-house',
    behaviour: 'A cannonball and a meteor go through a house with local damage; the roof holds unless its support truly fails',
    harness: { kind: 'testbed', build: 'monster', trials: ['cannonball-framed-house', 'meteor-framed-house', 'smallshots-framed-house'] },
    judge(dir) {
      const runs = testbedRuns(dir);
      const ball = run(runs, 'cannonball-framed-house'), meteor = run(runs, 'meteor-framed-house'), small = run(runs, 'smallshots-framed-house');
      return [
        ...houseChecks(small, { band: BAND.small, through: (r) => ({ check: 'gets past the brick face (m)', measured: fmt(r.attack?.pastTarget), threshold: '>= 1', pass: (r.attack?.pastTarget ?? 0) >= 1 }) }).map((c) => ({ ...c, check: `three 100 kg balls between the studs: ${c.check}` })),
        energyCheck(ball, 'cannonball', 1),
        energyCheck(meteor, 'meteor', 8),
        ...houseChecks(ball, { local: true, band: BAND.ball, through: (r) => ({ check: 'gets past the front wall (m)', measured: fmt(r.attack?.pastTarget), threshold: '>= 1', pass: (r.attack?.pastTarget ?? 0) >= 1 }) }).map((c) => ({ ...c, check: `cannonball: ${c.check}` })),
        // The meteor (2 m radius, through the whole house) takes the roof's
        // supports on its path, so its roof may come down where they went: only
        // through-ness and the steps are gated, the rest measured.
        ...houseChecks(meteor, { band: BAND.meteor, through: (r) => ({ check: 'goes through the house (m past the front wall)', measured: fmt(r.attack?.pastTarget), threshold: '>= 8', pass: (r.attack?.pastTarget ?? 0) >= 8 }) })
          .map((c) => ({ ...c, check: `meteor: ${c.check}`, ...(/^(roof|frame)/.test(c.check) ? { threshold: 'measured (its path takes supports)', pass: true } : {}) })),
      ];
    },
  },
  {
    id: 'crush-only-where-hit',
    behaviour: 'Crushing happens only where the projectile actually hits',
    harness: { kind: 'testbed+qualify', build: 'monster', trials: ['rest', 'near-miss', 'knock-mirror', 'cannonball-framed-house'], qualify: ['veneer', 'town'] },
    judge(dir, profile) {
      const runs = testbedRuns(dir);
      const out = [];
      for (const t of ['rest', 'near-miss', 'knock-mirror']) {
        const r = run(runs, t);
        out.push({ check: `${t}: chunks crushed (nothing hits a structure)`, measured: r ? r.crushedChunks : 'missing', threshold: '0', pass: !!r && r.crushedChunks === 0 });
      }
      const hit = run(runs, 'cannonball-framed-house');
      out.push({ check: 'cannonball into the house: chunks crushed', measured: hit ? hit.house?.crushedChunks ?? hit.crushedChunks : 'missing', threshold: profile === 'high' ? '>= 1 (crush on)' : 'measured (crush off)', pass: !!hit && (profile !== 'high' || (hit.house?.crushedChunks ?? hit.crushedChunks) >= 1) });
      for (const q of ['veneer', 'town']) {
        const res = qualify(dir, q);
        const crushed = res?.filter((r) => r.verdict === 'CRUSH').length;
        out.push({ check: `${q} at rest: structures that crush`, measured: res ? crushed : 'missing', threshold: '0', pass: !!res && crushed === 0 });
      }
      out.push({ check: 'crushes are where the projectile hit (positions)', measured: 'not recorded', threshold: 'every crushed chunk within the projectile\'s swept radius', pass: false, note: 'gap: no harness records crush positions (native_gameplay a_crushable_wall_crushes_where_it_is_struck checks only that something crushed)' });
      return out;
    },
  },
  {
    id: 'houses-stand-and-converge',
    behaviour: 'Houses stand at rest and converge',
    harness: { kind: 'qualify', pack: 'veneer', structures: ['veneer-bungalow', 'veneer-house', 'veneer-bungalow--frame', 'veneer-house--frame'] },
    judge(dir) {
      const res = qualify(dir, 'veneer');
      return ['veneer-bungalow', 'veneer-house', 'veneer-bungalow--frame', 'veneer-house--frame'].map((s) => {
        const r = res?.find((x) => x.structure === s);
        return { check: `${s}: stands and converges at rest`, measured: r ? `${r.verdict}, ${fmt(r.unconverged_pct, 1)}% unconverged, ${fmt(r.broken_pct)}% broken` : 'missing', threshold: 'PASS (<= 10% unconverged, <= 0.5% broken)', pass: r?.verdict === 'PASS' };
      });
    },
  },
  {
    id: 'studless-houses-collapse',
    behaviour: 'With the studs removed, the houses collapse',
    harness: { kind: 'qualify', pack: 'veneer', structures: ['veneer-bungalow--no-front-studs', 'veneer-house--no-front-studs', 'veneer-house--no-ground-front-studs'] },
    judge(dir) {
      const res = qualify(dir, 'veneer');
      // qualify-veneer-houses.mjs COLLAPSE_SHARE: 2% of bonds broken at rest.
      return ['veneer-bungalow--no-front-studs', 'veneer-house--no-front-studs', 'veneer-house--no-ground-front-studs'].map((s) => {
        const r = res?.find((x) => x.structure === s);
        return { check: `${s}: collapses (bonds broken at rest)`, measured: r ? `${fmt(r.broken_pct)}%` : 'missing', threshold: '>= 2% (qualify-veneer-houses COLLAPSE_SHARE)', pass: !!r && r.broken_pct >= 2 };
      });
    },
  },
  {
    id: 'roof-drawn-where-physics-has-it',
    behaviour: 'The roof is drawn where the physics has it (client chunk placement vs server, 1 mm)',
    harness: { kind: 'wire-poses', tests: ['a_studless_house_collapsing_is_drawn_where_the_server_has_it', 'a_cannonball_hit_is_drawn_where_the_server_has_it'] },
    judge(dir) {
      return ['a_studless_house_collapsing_is_drawn_where_the_server_has_it', 'a_cannonball_hit_is_drawn_where_the_server_has_it'].map((t) => {
        const s = status(dir, `wire-${t}`);
        return { check: t.replaceAll('_', ' '), measured: s ?? 'missing', threshold: 'ok (worst <= 1 mm)', pass: s?.startsWith('ok') };
      });
    },
  },
  {
    id: 'stairs-walkable',
    behaviour: 'Stairs are walkable (the game player walks the two-storey veneer house up and down)',
    harness: { kind: 'walk', pack: 'veneer', structure: 'veneer-house' },
    judge(dir) {
      const s = status(dir, 'walk');
      return [{ check: 'route walk: up and down the stair', measured: s ?? 'missing', threshold: 'ok (no fall > a riser, headroom >= 2.032 m, nothing breaks)', pass: s?.startsWith('ok') }];
    },
  },
  {
    id: 'car-coasts-ride-height',
    behaviour: 'The car coasts down; its ride height is right after near misses and lost parts',
    harness: { kind: 'testbed', build: 'monster', trials: ['coast', 'knock-mirror', 'knock-mirror-driving', 'debris-wheel', 'near-miss'] },
    judge(dir) {
      const v = testbedVerdict(dir);
      const rows = v?.filter((r) => r.car === 'monster' && (r.trial === 'coast' || (['knock-mirror', 'knock-mirror-driving', 'debris-wheel', 'near-miss'].includes(r.trial) && r.criterion.startsWith('ride height'))));
      if (!rows?.length) return [{ check: 'criteria rows', measured: 'missing', threshold: 'present', pass: false }];
      return rows.map((r) => ({ check: `${r.trial}: ${r.criterion}`, measured: r.value, threshold: `${r.threshold} (criteria.mjs)`, pass: r.pass }));
    },
  },
  {
    id: 'turning-slalom-avoidance',
    behaviour: 'Turning, slalom and avoidance still pass',
    harness: { kind: 'testbed+node', build: 'monster', trials: ['drift'], node: 'node --test client/native/film/*.test.mjs' },
    judge(dir) {
      const v = testbedVerdict(dir);
      const rows = (v ?? []).filter((r) => r.car === 'monster' && r.trial === 'drift').map((r) => ({ check: `drift: ${r.criterion}`, measured: r.value, threshold: `${r.threshold} (criteria.mjs)`, pass: r.pass }));
      const s = status(dir, 'driving-tests');
      rows.push({ check: 'driving and film unit tests (node --test client/native/film/*.test.mjs)', measured: s ?? 'missing', threshold: 'ok', pass: s?.startsWith('ok') });
      rows.push({ check: 'slalom and avoidance on the GPU (scripts/turning-lab.sh slalom|avoid)', measured: 'not gated', threshold: 'cones hit 0, gates passed', pass: false, note: 'gap: turning-lab is an in-app film with no pass/fail criteria; it reports cones hit, path RMS and gate offsets only' });
      return rows;
    },
  },
  {
    id: 'vibe-town-qualifies',
    behaviour: 'Vibe Town qualifies at rest (every structure converges and stands)',
    harness: { kind: 'qualify', pack: 'town' },
    judge(dir) {
      const res = qualify(dir, 'town');
      if (!res) return [{ check: 'qualification', measured: 'missing', threshold: 'all PASS', pass: false }];
      const by = (v) => res.filter((r) => r.verdict === v).length;
      const bad = res.filter((r) => ['FAIL', 'FALLS', 'ERROR', 'CRUSH'].includes(r.verdict));
      return [{ check: 'structures that fail, fall, crush or error at rest', measured: `${bad.length} of ${res.length} (PASS ${by('PASS')}, FREE ${by('FREE')}, FAIL ${by('FAIL')}, FALLS ${by('FALLS')}, CRUSH ${by('CRUSH')}, ERROR ${by('ERROR')})${bad.length ? ': ' + bad.slice(0, 6).map((r) => `${r.structure} ${r.verdict}`).join(', ') : ''}`, threshold: '0', pass: bad.length === 0 }];
    },
  },
];

const [cmd, profile, dir] = process.argv.slice(2);
if (cmd === 'list') {
  console.log(JSON.stringify(SCENARIOS.map(({ judge, ...s }) => s), null, 1));
} else if (cmd === 'judge') {
  const expected = new Map();
  const ef = path.join(path.dirname(new URL(import.meta.url).pathname), 'acceptance-expected.tsv');
  if (existsSync(ef)) for (const line of readFileSync(ef, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [p, id, check, measured] = line.split('\t');
    expected.set(`${p}\t${id}\t${check}`, measured);
  }
  let failing = 0;
  for (const s of SCENARIOS) {
    console.log(`\n${s.id} -- ${s.behaviour}`);
    for (const c of s.judge(dir, profile)) {
      const known = expected.has(`${profile}\t${s.id}\t${c.check}`);
      const st = c.pass ? (known ? 'FIXED' : 'PASS') : known ? 'KNOWN-GAP' : 'FAIL';
      if (st === 'FAIL') failing++;
      console.log(`  ${c.check.padEnd(64)} ${String(c.measured).padEnd(28)} ${String(c.threshold).padEnd(34)} ${st}${c.note ? `  (${c.note})` : ''}`);
      appendFileSync(path.join(dir, 'acceptance.jsonl'), JSON.stringify({ profile, scenario: s.id, behaviour: s.behaviour, check: c.check, measured: c.measured, threshold: c.threshold, status: st, note: c.note ?? null }) + '\n');
    }
  }
  process.exitCode = failing ? 1 : 0;
} else {
  console.error('usage: acceptance.mjs list | judge PROFILE DIR');
  process.exitCode = 2;
}
