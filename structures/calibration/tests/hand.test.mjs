// CPU tests of the calibration hand calculations (no GPU):
//   node --test structures/calibration/tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { frame } from '../src/frame2d.mjs';
import { rcRect, designAs, CONCRETE } from '../src/materials.mjs';
import * as B from '../src/bridge-slab.mjs';
import * as T from '../src/truss.mjs';
import * as F from '../src/frame-building.mjs';

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${what}: ${a} vs ${b}`);

test('frame2d: textbook beams', () => {
  const w = 10e3, L = 10;
  let f = frame(); const n = []; for (let i = 0; i <= 20; i++) n.push(f.node(i, 0));
  for (let i = 0; i < 20; i++) f.member(n[i], n[i + 1], { E: 30e9, A: 1, I: 0.1, w });
  f.fix(n[0], 'xy'); f.fix(n[10], 'y'); f.fix(n[20], 'y');
  let r = f.solve();
  close(r.moment(9, 1), -w * L * L / 8, 1e-9, 'two-span support moment wL^2/8');
  close(r.reactions.get(n[10])[1], 1.25 * w * L, 1e-9, 'two-span centre reaction 1.25 wL');
  f = frame(); const a = f.node(0, 0), b = f.node(5, 0), c = f.node(10, 0);
  f.member(a, b, { E: 30e9, A: 1, I: 0.1, w }); f.member(b, c, { E: 30e9, A: 1, I: 0.1, w }); f.fix(a); f.fix(c);
  r = f.solve();
  close(r.moment(0, 0), -w * L * L / 12, 1e-9, 'fixed-end wL^2/12');
  close(r.moment(0, 5), w * L * L / 24, 1e-9, 'fixed-fixed midspan wL^2/24');
  f = frame(); const p = f.node(0, 0), q = f.node(3, 4); f.member(p, q, { E: 30e9, A: 1, I: 0.1, w: 1000 }); f.fix(p);
  r = f.solve();
  close(r.at(0, 0).M, -7500, 1e-9, 'inclined cantilever base moment');
  close(r.at(0, 0).N, -4000, 1e-9, 'inclined cantilever axial');
});

test('rcRect: EN 1992 stress block and links', () => {
  const s = rcRect({ b: 1, h: 0.5, cover: 0.05, As: 2e-3, concrete: CONCRETE.C30 });
  const x = 2e-3 * 500e6 / (0.8 * 30e6 * 1);
  close(s.M_Rk, 2e-3 * 500e6 * (0.45 - 0.4 * x), 1e-12, 'M_Rk = As fyk (d - 0.4 x)');
  assert.ok(s.M_yk < s.M_Rk && s.M_yk > 0.85 * s.M_Rk, 'first yield just under the ultimate moment');
  const l = rcRect({ b: 0.3, h: 0.6, cover: 0.05, As: 6e-4, concrete: CONCRETE.C30, links: { Asw: 100e-6, s: 0.15 } });
  close(l.V_Rk, 100e-6 / 0.15 * 0.9 * 0.55 * 500e6 * 2.5, 1e-12, 'V_Rk,s with cot theta 2.5');
  const As = designAs(300e3, 0.3, 0.55, CONCRETE.C30);
  const d = rcRect({ b: 0.3, h: 0.6, cover: 0.05, As, concrete: CONCRETE.C30 });
  assert.ok(d.M_Rk > 300e3 * 1.1 && d.M_Rk < 300e3 * 1.4, `characteristic capacity of a design for 300 kN m: ${d.M_Rk}`);
});

test('bridge: removals raise the deck moment as the span grows', () => {
  const D = B.design(B.BRIDGE), u = [[], [1], [1, 4], [1, 2, 4]].map((rm) => B.check(B.BRIDGE, rm, D).worst.u);
  assert.ok(u[0] < 0.3 && u[1] < 0.85 && u[2] < 0.85 && u[3] > 1.15, `steps ${u}`);
  // A 20 m span continuous both ends against a 30 m one: (30/20)^2 = 2.25, give or take the continuity.
  assert.ok(u[3] / u[2] > 2 && u[3] / u[2] < 2.7, `ratio ${u[3] / u[2]}`);
  const lumped = B.check(B.BRIDGE, [1, 2, 4], D, { lumped: true }).worst.u;
  close(lumped, u[3], 0.005, 'lumped chunk weights');
});

test('truss: pin-jointed forces by the method of sections', () => {
  // Simply supported (pin and roller): the textbook truss. (The calibration bridge's bearings are both fixed.)
  const P = { ...T.TRUSS, support: 'pinned' }, f = T.forces(P, [], { pinned: true });
  // Panel 3's bottom chord (B2-B3): moments about T2 (x 8), where the diagonal T2-B3 and the
  // top chord meet. Panel loads only, so the members' own weight puts it up to ~10% higher.
  const Pn = T.panelLoad(P), M = 2.5 * Pn * 8 - Pn * 4;
  const N = f['B2-B3'].mid.N;
  assert.ok(N > M / P.height && N < 1.12 * M / P.height, `bottom chord ${N} vs ${M / P.height}`);
  assert.ok(Math.abs(f['B3-T3'].mid.N) < 0.05 * Pn, 'midspan vertical carries next to nothing');
  assert.throws(() => T.forces(P, ['T2-B3'], { pinned: true }), /mechanism/);
  assert.throws(() => T.forces(P, ['B2-B3'], { pinned: true }), /mechanism/);
  // Both bearings fixed: a cut bottom chord leaves a two-hinged arch, which stands.
  assert.doesNotThrow(() => T.forces(T.TRUSS, ['B2-B3'], { pinned: true }));
});

test('frame: GSA removal demands', () => {
  for (const [kind, rm, lo, hi] of [['ordinary', [], 0, 0.85], ['ordinary', [0], 1.15, 99], ['ordinary', [1], 1.15, 99], ['robust', [0], 0, 0.85], ['robust', [1], 0, 0.85]]) {
    const P = F.params(kind), u = F.check(P, rm, F.design(P, kind)).worst.u;
    assert.ok(u >= lo && u <= hi, `${kind} ${rm}: u ${u}`);
  }
});

test('house headers: the double top plate over a knocked-out bay (revision 2 bungalow)', async () => {
  const H = await import('../src/house-headers.mjs');
  const { buildVeneerHouse } = await import('../../town-kit/src/veneer-houses.mjs');
  const { pack, metadata } = buildVeneerHouse({ storeys: 1, revision: 2 });
  // Two nailed plies (EN 1995-1-1 Annex B): nearly no composite action, half the solid section's moment.
  assert.ok(H.CAP.gamma(2) < 0.05, `gamma ${H.CAP.gamma(2)}`);
  close(H.PLATES.real.W * H.PLATES.real.fm, 1458, 0.01, 'M_Rk of two 45 x 90 C24 plies');
  close(H.PLATES.kit.W * H.PLATES.kit.fm, H.PLATES.real.W * H.PLATES.real.fm, 1e-9, "the kit's member has the plies' moment capacity");
  // One bay (the door's left jack and king), two bays: the plate spans 1.36 m, then 1.96 m, and holds.
  const bay1 = H.gapCheck(pack, metadata.nodeWalls, [1.532, 1.577]), bay2 = H.gapCheck(pack, metadata.nodeWalls, [1.163, 1.532, 1.577]);
  close(bay1.gap, 1.359, 0.01, 'one bay: the gap from the stud at 1.163 to the door header\'s right jack');
  close(bay2.gap, 1.959, 0.01, 'two bays');
  assert.ok(bay1.real.u < 0.85 && bay2.real.u < 0.85, `bays hold: ${bay1.real.u} ${bay2.real.u}`);
  // A simply supported span under its seats: M between wL^2/12 and wL^2/8 of its line load.
  assert.ok(bay2.Mlow < bay2.M && bay2.M / bay2.Mlow < 1.8, `bounds ${bay2.Mlow} ${bay2.M}`);
  // The truck's hole (five studs, 3.33 m): past the plate's strength between both bounds.
  const truck = H.gapCheck(pack, metadata.nodeWalls, [-1.238, -0.637, -0.037, 0.563, 1.163]);
  close(truck.gap, 3.332, 0.01, 'the truck\'s gap, junction stud to the door\'s left king');
  assert.ok(truck.real.uLow > 1.15, `truck: the plate fails, u ${truck.real.uLow}-${truck.real.u}`);
  // Bearing beside the gaps stays under f_c,90,k.
  for (const g of [bay1, bay2, truck]) assert.ok(g.endReaction.every((q) => q.u < 1), JSON.stringify(g.endReaction));
});
