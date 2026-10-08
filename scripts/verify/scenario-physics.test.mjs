// The scenario matrix's closed forms against hand calculations and their own
// invariants (node --test scripts/verify/scenario-physics.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ndrc, ndrcG, xOverD, perforationOverD, ndrcBallisticLimit, rechtIpson, throughLayers, vehicleImpactForce, timberBendingWork, sphereDiameter, NOSE } from './scenario-physics.mjs';

const near = (a, b, rel, what) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${what}: ${a} vs ${b}`);

test('NDRC by hand: a 100 kg steel sphere at 60 m/s into 10 MPa masonry', () => {
  // d = 2 (3 x 100 / 4 pi 7850)^(1/3) = 0.2898 m = 11.41 in; W 220.46 lb; V 196.85 ft/s;
  // f'c 1450 psi: K = 180/38.08 = 4.727; G = 4.727 x 0.84 x (220.46/11.41) x (196.85/11410)^1.8
  // = 3.971 x 19.32 x 6.70e-4 = 0.0514; x/d = 2 sqrt(G) = 0.4535.
  const d = sphereDiameter(100, 7850);
  near(d, 0.2898, 0.001, 'diameter');
  const G = ndrcG(100, d, 60, 10e6, NOSE.sphere);
  near(G, 0.0514, 0.01, 'G');
  near(ndrc(100, d, 60, 10e6).penetration, 0.4535 * d, 0.01, 'penetration');
});

test('NDRC branches meet where they switch', () => {
  near(xOverD(1 - 1e-9), xOverD(1 + 1e-9), 1e-6, 'x/d at G = 1');
  near(perforationOverD(1.35), 1.32 + 1.24 * 1.35, 0.002, 'e/d at x/d = 1.35');
});

test('the ballistic limit inverts the perforation thickness', () => {
  const d = sphereDiameter(1000, 7850);
  for (const h of [0.09, 0.25, 0.5]) {
    const v = ndrcBallisticLimit(1000, d, h, 10e6);
    near(ndrc(1000, d, v, 10e6).perforation, h, 1e-4, `e at v_bl for h ${h}`);
  }
});

test('Recht-Ipson conserves momentum with the plug and loses the energy of the limit', () => {
  const m = 100, mp = 30, v = 60, vbl = 36;
  const vr = rechtIpson(m, mp, v, vbl);
  // Free of the limit, it is the inelastic plug: m v = (m + m_p) v_r.
  near(rechtIpson(m, mp, v, 0) * (m + mp), m * v, 1e-12, 'momentum');
  assert.ok(vr < rechtIpson(m, mp, v, 0));
  assert.equal(rechtIpson(m, mp, 30, vbl), 0);
});

test('a carried plug slows a car layer by layer; a shot leaves its plug behind', () => {
  const layers = [{ name: 'a', thickness: 0.1, density: 2000, work: 0 }, { name: 'b', thickness: 0.1, density: 2000, work: 0 }];
  const car = throughLayers({ mass: 1000, diameter: 1, frontalArea: 1, speed: 10, carries: true }, layers);
  // 1000 -> +200 kg each: 10 x 1000/1200, then x 1200/1400.
  near(car.exitSpeed, 10 * 1000 / 1400, 1e-9, 'car exit');
  const shot = throughLayers({ mass: 1000, diameter: 1, frontalArea: 1, speed: 10 }, layers);
  near(shot.exitSpeed, 10 * (1000 / 1200) ** 2, 1e-9, 'shot exit');
});

test('EN 1991-1-7 Annex C: a 5 t truck at 20 m/s', () => {
  const { force, seconds } = vehicleImpactForce(5000, 20);
  near(force, 774.6e3, 1e-3, 'F = v sqrt(k m)');
  near(seconds, 0.1291, 1e-3, 'dt = sqrt(m/k)');
});

test('a C24 stud breaks in bending at a few kN and tens of joules', () => {
  const { load, work } = timberBendingWork(0.038, 0.089, 2.4);
  near(load, 3010, 0.01, 'P_u');
  assert.ok(work > 10 && work < 200, `work ${work}`);
});
