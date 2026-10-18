// node --test client/native/film: the closed-loop driver's pure parts --
// paths, the identified truck model, the tracking law, the meter and the
// avoidance planner -- without the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePath, route, project, pointAt } from './path.mjs';
import { MONSTER, lockFraction, lockLimit, steerTarget, curvatureOf, keyFor, maxCurvature, initialState, step, handbrakeTurnDeg } from './vehicle-model.mjs';
import { createDriver, speedProfile } from './driver.mjs';
import { fitCircle, coneInFootprint, coneClearance } from './meter.mjs';
import { footprintDistance, hazardsOnNominal, seeded, plan } from './planner.mjs';
import { simulateAvoid } from './simulate.mjs';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what ?? ''} ${a} vs ${b} (±${eps})`);

test('a route arc has curvature 1/R and ends where it should', () => {
  const r = route({ x: 0, z: 0, psi: 0 }, [{ line: 10 }, { arc: Math.PI / 2, R: 20 }, { line: 5 }]);
  near(r.end.x, 25, 1e-6, 'end x'); near(r.end.z, 30, 1e-6, 'end z'); near(r.end.psi, Math.PI / 2, 1e-9, 'end heading');
  const p = makePath(r.points);
  near(pointAt(p, 10 + 15).kappa, 1 / 20, 0.002, 'arc curvature');
  near(pointAt(p, 5).kappa, 0, 1e-6, 'line curvature');
  near(p.length, 10 + (Math.PI / 2) * 20 + 5, 0.05, 'length');
});

test('projection: signed offset on the +psi side, and the hint keeps a figure eight on its lobe', () => {
  const p = makePath(route({ x: 0, z: 0, psi: 0 }, [{ line: 50 }]).points);
  const a = project(p, 2, 20);
  near(a.s, 20, 1e-6); near(a.e, 2, 1e-6, 'east of a north path is +psi');
  const eight = makePath(route({ x: 0, z: 0, psi: 0 }, [{ line: 10 }, { arc: -2 * Math.PI, R: 10 }, { arc: 2 * Math.PI, R: 10 }]).points);
  // At the crossing (s 10 and s 10 + 2 pi R): the hint decides which.
  near(project(eight, 0, 10.2, 10 + 2 * Math.PI * 10 - 1).s, 10 + 2 * Math.PI * 10, 1.5, 'second pass');
});

test('the server steering rules: full lock to 6 m/s, the lateral cap above', () => {
  assert.equal(lockFraction(5), 1);
  near(lockFraction(28), 0.35, 1e-9);
  assert.equal(lockLimit(5), 1);
  // 7.5 m/s^2 over a 3 m wheelbase at 20 m/s.
  near(lockLimit(20), Math.atan((7.5 * 3) / 400) / 0.3839724354387525, 1e-9);
  near(steerTarget(-0.5, 20), -0.5 * lockLimit(20), 1e-12);
});

test('the model holds the measured steady turns (sysid 2026-10-06)', () => {
  // [speed, key, yaw rate measured]
  for (const [v, u, r] of [[4.58, 1, -0.512], [7.5, 1, -0.835], [10.5, 1, -0.639], [16.5, 1, -0.427], [24.4, 1, -0.295], [13.6, -0.5, 0.26]]) {
    const s = initialState({ vf: v });
    for (let k = 0; k < 180; k += 1) { step(s, { forward: 0.02, strafe: u }); s.vf = v; }
    near(s.r, r, Math.abs(r) * 0.06, `yaw at ${v} m/s key ${u}`);
  }
});

test('keyFor inverts the curvature map, and says when a turn is out of reach', () => {
  for (const v of [3, 8, 14, 22]) {
    const kmax = maxCurvature(v);
    for (const f of [-0.9, -0.3, 0.2, 0.8]) {
      const k = { u: keyFor(f * kmax, v).u };
      near(curvatureOf(steerTarget(k.u, v)), f * kmax, 1e-6, `v ${v} f ${f}`);
    }
    assert.ok(keyFor(1.2 * kmax, v).saturated);
  }
  // At low speed full lock is an ~8.9 m circle (measured 8.9 at 4.5 m/s).
  near(1 / maxCurvature(4.5), 8.95, 0.3, 'tightest radius');
});

test('handbrake table: measured headings, interpolated', () => {
  near(handbrakeTurnDeg(12.6), 67, 1e-9); near(handbrakeTurnDeg(14.55), 85.5, 0.1);
});

function track(path, profile, seconds, start) {
  const d = createDriver();
  d.follow({ path, profile });
  const s = initialState(start);
  let sq = 0, n = 0, worst = 0;
  for (let k = 0; k < seconds * 60; k += 1) {
    const vl = s.r * (MONSTER.lateralArm - MONSTER.lateralArmFade * s.vf * s.vf);
    step(s, d.step({ p: [s.x, 0, s.z], psi: s.psi, vf: s.vf, vl, w: [0, s.r, 0] }));
    if (k > 120) { const e = project(path, s.x, s.z, d.s).e; sq += e * e; n += 1; worst = Math.max(worst, Math.abs(e)); }
  }
  return { rms: Math.sqrt(sq / n), worst, s };
}

test('the driver holds a 20 m circle at 10 m/s within 0.2 m on the model', () => {
  const r = route({ x: 0, z: 0, psi: 0 }, [{ arc: 4 * Math.PI, R: 20 }]);
  const p = makePath(r.points.slice(0, -1), { closed: true });
  const out = track(p, new Float64Array(p.n).fill(10), 15, { x: 0, z: 0, psi: 0, vf: 10 });
  assert.ok(out.rms < 0.2, `rms ${out.rms}`);
});

test('speed plans respect the lock: a 12 m circle is not planned faster than the truck can turn it', () => {
  const p = makePath(route({ x: 0, z: 0, psi: 0 }, [{ arc: 2 * Math.PI, R: 12 }]).points.slice(0, -1), { closed: true });
  const v = speedProfile(p, { vmax: 20, latAcc: 9 });
  for (const s of v) assert.ok(maxCurvature(s) >= 1 / 12 * 1.0, `planned ${s} m/s`);
});

test('meter: a circle fit, and the footprint test', () => {
  const pts = Array.from({ length: 50 }, (_, k) => [3 + 15 * Math.cos(k / 8), -2 + 15 * Math.sin(k / 8)]);
  const c = fitCircle(pts);
  near(c.R, 15, 1e-6); near(c.cx, 3, 1e-6); near(c.cz, -2, 1e-6);
  const st = { p: [0, 1, 0], psi: 0 };
  assert.ok(coneInFootprint(st, 1.5, 2, { hl: 2.45, hw: 1.5, cone: 0.16 }));
  assert.ok(!coneInFootprint(st, 1.8, 0, { hl: 2.45, hw: 1.5, cone: 0.16 }));
  near(coneClearance(st, 3, 0, { hl: 2.45, hw: 1.5, cone: 0.16 }), 3 - 1.5 - 0.16, 1e-9);
  near(footprintDistance(0, 0, Math.PI / 2, 0, 5), 5 - MONSTER.halfWidth, 1e-9, 'turned east, a point north is off its side');
});

test('the planner steers or brakes round rocks dropped where it would have been (model)', async () => {
  const start = { x: 0, z: 0, psi: 0 };
  const road = makePath(route(start, [{ line: 260 }]).points);
  let worst = Infinity;
  for (const seed of [3, 11]) {
    const rand = seeded(seed);
    const hazards = hazardsOnNominal(road, 14, start, [4.5, 7, 9.6], { rand });
    // Without avoidance the truck would be on each of them (within 1.5 m of the middle of its path).
    for (const h of hazards) assert.ok(Math.abs(h.x) < 1.5);
    const r = await simulateAvoid({ route: road, speed: 14, start, hazards, seconds: 12 });
    worst = Math.min(worst, ...r.clearances);
    assert.ok(!r.hit, `seed ${seed}: ${r.clearances}`);
  }
  assert.ok(worst > 0.5, `closest ${worst} m`);
  // And a single plan from rest is not a stop when nothing is in the way.
  const p = plan({ p: [0, 1, 0], psi: 0, vf: 10, vl: 0, w: [0, 0, 0] }, 0, { route: road, speed: 14, hazards: [] });
  assert.equal(p.D, 0); assert.equal(p.factor, 1);
});
