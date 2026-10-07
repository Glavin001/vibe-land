/**
 * Calibration 3 (docs/calibration/frame-column.md): a three-storey reinforced
 * concrete frame with precast floor planks, a ground-floor column removed per
 * GSA 2016 / UFC 4-023-03 (alternate path).
 *
 * The building: 3 bays of 6 m (x) by one bay of 6 m (z), storeys 3.5 m; two
 * moment frames (z 0 and z 6) of 400 x 400 columns and 300 x 600 beams (C30/37,
 * B500B), joined at every column line by 300 x 600 transverse beams. The floors
 * are 200 mm precast planks, 1.2 m wide, spanning 6.3 m between the frames'
 * beams on bearing strips: simply supported and untied -- resting on the
 * beams, not bonded to them (on the stage they load the frame through
 * contact). Their weight carries the floor's dead load, finishes 1.5 kPa and
 * half the 3 kPa office imposed load (GSA 2016 3.2.4 / UFC 4-023-03 3-2.11:
 * 1.2 D + 0.5 L is the load at the time of the event; the static stage carries
 * D + 0.5 L), smeared into the plank's density.
 *
 * Two designs of the same frame:
 *   ordinary  beams designed to EN 1992-1-1 for the ULS of the intact frame
 *             (1.35 G + 1.5 Q, EN 1990 6.10)
 *   robust    beams designed for UFC 4-023-03's linear-static alternate path:
 *             every interior and corner ground-floor column removed in turn,
 *             2.0 (1.2 D + 0.5 L) over the bays above it (Omega_LD 2, the
 *             dynamic increase of a sudden removal), m = 1
 *
 * The hand calculation: each frame line as a plane frame (frame2d.mjs), the
 * planks' reactions as a line load on its beams, the transverse beams' and
 * columns' weight at the joints. A removed column is the frame without it.
 * The other frame does not help a frame that lost a column (the planks are
 * simply supported between them), except through the transverse beams'
 * bending and torsion -- which the plane analysis leaves out, so it can only
 * help (conservative), within the band.
 *
 * Exterior stair tower (stairs.mjs townStaircase, the kit's dogleg with a
 * 1.35 m half landing) at the x 18 end, on its own footing: not part of the
 * frame's load path.
 */
import { frame } from './frame2d.mjs';
import { Pack } from './pack.mjs';
import { CONCRETE, RC_DENSITY, rcRect, rcMaterial, designAs, packMaterial } from './materials.mjs';

const G = 9.81;

export const FRAME = {
  key: 'rc-frame',
  bays: 3, bay: 6.0, depth: 6.0, storeys: 3, storey: 3.5,
  column: 0.4, beam: { b: 0.3, h: 0.6 }, plank: { t: 0.2, w: 1.2 },
  cover: 0.05, concrete: CONCRETE.C30,
  loads: { finishes: 1.5e3, imposed: 3.0e3 },
  beamChunk: 0.8,
};

/** The robust design needs deeper beams for the alternate path (K <= 0.167 without compression steel). */
export const params = (kind) => (kind === 'robust' ? { ...FRAME, key: FRAME.key, beam: { b: 0.35, h: 0.8 }, column: 0.5, columnRho: 0.02 } : FRAME);

export const columnsX = (P = FRAME) => Array.from({ length: P.bays + 1 }, (_, i) => i * P.bay);
const floorY = (P, k) => (k + 1) * P.storey;            // top of plank, floor k (0-based)
const beamY = (P, k) => [floorY(P, k) - P.plank.t - P.beam.h, floorY(P, k) - P.plank.t];

/** Load per m^2 the planks carry: self-weight, finishes, half the imposed (D + 0.5 L). */
export const floorLoad = (P = FRAME) => P.plank.t * RC_DENSITY * G + P.loads.finishes + 0.5 * P.loads.imposed;
/** The plank's density with the floor's loads smeared in. */
export const plankDensity = (P = FRAME) => floorLoad(P) / (P.plank.t * G);

/** Beam line load (N/m) on a frame line: half the planks' span (they bear 6.3 m between beam centres +-0.15) and its own weight. */
export function beamLoad(P = FRAME, { q = floorLoad(P) } = {}) {
  const plankL = P.depth + P.beam.b;
  return q * plankL / 2 + P.beam.b * P.beam.h * RC_DENSITY * G;
}

/**
 * One frame line as a plane frame, columns `removed` (indices along x,
 * ground floor), beam line load `w`, transverse-beam weight at each joint.
 */
export function model(P = FRAME, removed = [], { w = beamLoad(P), beam, column }) {
  const f = frame(), xs = columnsX(P), node = [];
  for (let k = 0; k <= P.storeys; k++) node.push(xs.map((x) => f.node(x, k === 0 ? 0 : (beamY(P, k - 1)[0] + beamY(P, k - 1)[1]) / 2)));
  const cols = [], beams = [];
  const colW = P.column ** 2 * RC_DENSITY * G;
  for (let k = 0; k < P.storeys; k++) for (let i = 0; i < xs.length; i++) {
    if (k === 0 && removed.includes(i)) continue;
    cols.push({ k, i, m: f.member(node[k][i], node[k + 1][i], { E: column.E, A: column.A, I: column.I, w: colW }) });
  }
  for (let k = 1; k <= P.storeys; k++) for (let i = 0; i < xs.length - 1; i++) beams.push({ k, i, m: f.member(node[k][i], node[k][i + 1], { E: beam.E, A: beam.A, I: beam.I, w }) });
  for (let i = 0; i < xs.length; i++) if (!removed.includes(i)) f.fix(node[0][i]);
  // Each joint: half a transverse beam (5.6 m clear between the frames' columns).
  const tw = P.beam.b * P.beam.h * (P.depth - P.column) * RC_DENSITY * G / 2;
  for (let k = 1; k <= P.storeys; k++) for (let i = 0; i < xs.length; i++) f.load(node[k][i], 0, -tw, 0);
  return { f, cols, beams, node, xs };
}

/** Beam moments (and shear) at the column faces and every beam chunk joint; columns at each storey's ends. */
export function check(P, removed, D, { bendingModulus = (s) => s.S, w } = {}) {
  const m = model(P, removed, { beam: D.beam, column: D.column, w }), r = m.f.solve(), out = [];
  const beamMat = rcMaterial('beam', D.beam), colMat = rcMaterial('column', D.column);
  const fibre = (N, M, sec, mat) => { const sb = Math.abs(M) / bendingModulus(sec), sn = N / sec.A; return Math.max(Math.max(0, sn + sb) / mat.tensionElastic, Math.max(0, sb - sn) / mat.compressionElastic); };
  for (const b of m.beams) {
    const L = P.bay, c = P.column / 2;
    for (const s of beamCuts(P)) {
      const F = r.at(b.m, s);
      const u = Math.max(fibre(F.N, F.M, D.beam, beamMat), Math.abs(F.V) / D.beam.A / beamMat.shearElastic);
      out.push({ key: `beam@${b.k}:${(b.i * L + s).toFixed(2)}`, member: 'beam', floor: b.k, x: b.i * L + s, M: F.M, V: F.V, N: F.N, u, face: Math.abs(s - c) < 1e-6 || Math.abs(s - (L - c)) < 1e-6 });
    }
  }
  for (const c of m.cols) {
    const [y0, y1] = columnSpan(P, c.k), L = r.member[c.m].g.L;
    for (const [s, end] of [[0, 'bottom'], [Math.min(L, y1 - y0), 'top']]) {
      const F = r.at(c.m, s);
      const u = Math.max(fibre(F.N, F.M, D.column, colMat), Math.abs(F.V) / D.column.A / colMat.shearElastic);
      out.push({ key: `column@${c.k}:${c.i}:${end}`, member: 'column', storey: c.k, line: c.i, N: F.N, M: F.M, V: F.V, u });
    }
  }
  return { bonds: out, worst: out.reduce((a, b) => (b.u > a.u ? b : a)), uplift: Math.max(...m.cols.filter((c) => c.k === 0).map((c) => r.reactions.get(m.node[0][c.i])?.[1] ?? 0)) };
}

/** Where along a bay (from the left column's centre) the stage has a beam bond: the column faces and the chunk joints. */
export function beamCuts(P = FRAME) {
  const c = P.column / 2, clear = P.bay - P.column, n = Math.round(clear / P.beamChunk), out = [c];
  for (let k = 1; k < n; k++) out.push(c + clear * k / n);
  out.push(P.bay - c);
  return out;
}
/** A storey's column between joints (y0, y1): from the floor below's joint top (or the ground) to this floor's beam soffit. */
export function columnSpan(P, k) { return [k === 0 ? 0 : floorY(P, k - 1), beamY(P, k)[0]]; }

/** Section design: ordinary (EN 1992 ULS of the intact frame) or robust (UFC 4-023-03 alternate path). */
export function design(P = FRAME, kind = 'ordinary') {
  // Beam links: two-leg 8 mm at 150 mm (A_sw 100 mm^2).
  const links = { Asw: 100e-6, s: 0.15 };
  const trial = rcRect({ b: P.beam.b, h: P.beam.h, cover: P.cover, As: 0.01 * P.beam.b * P.beam.h, concrete: P.concrete, links });
  const column = rcRect({ b: P.column, h: P.column, cover: P.cover, As: (P.columnRho ?? 0.01) / 2 * P.column ** 2, concrete: P.concrete }); // 1% total (EN 1992 9.5.2 min 0.2%; typical), robust 2%
  const plankL = P.depth + P.beam.b, Dself = P.plank.t * RC_DENSITY * G + P.loads.finishes, beamSelf = P.beam.b * P.beam.h * RC_DENSITY * G;
  const wD = Dself * plankL / 2 + beamSelf, wL = P.loads.imposed * plankL / 2;
  const envelope = (removedSets, wOf) => {
    let worst = 0;
    for (const rm of removedSets) {
      const m = model(P, rm, { beam: trial, column, w: wOf }), r = m.f.solve();
      for (const b of m.beams) for (const s of beamCuts(P)) worst = Math.max(worst, Math.abs(r.at(b.m, s).M));
    }
    return worst;
  };
  let M_Ed;
  if (kind === 'ordinary') M_Ed = envelope([[]], 1.35 * wD + 1.5 * wL);
  // UFC 4-023-03 linear static: Omega_LD 2.0 (RC) on 1.2 D + 0.5 L over the bays above the
  // removed column, against m kappa phi Q_CE with m = 2 (ASCE 41-13 Table 10-7, conforming RC
  // beams, collapse prevention, low shear): a demand of 1.0 (1.2 D + 0.5 L), designed here with
  // EN 1992's partial factors.
  else M_Ed = Math.max(envelope([[]], 1.35 * wD + 1.5 * wL), envelope([[0], [1]], 2.0 / 2.0 * (1.2 * wD + 0.5 * wL)));
  const As = designAs(M_Ed, P.beam.b, P.beam.h - P.cover, P.concrete);
  const beam = rcRect({ b: P.beam.b, h: P.beam.h, cover: P.cover, As, concrete: P.concrete, links });
  return { kind, M_Ed, As, beam, column, wD, wL };
}

/** Build the building (design `kind`) with ground-floor columns `removed` ([{i, frame}], frame 0 at z 0, 1 at z 6). */
export function build(P = FRAME, kind = 'ordinary', removed = [], { stair = true, charged = false } = {}) {
  const D = design(P, kind), xs = columnsX(P), pk = new Pack(`${P.key}-${kind}${removed.length ? `-no-${removed.map((r) => `${r.frame}${r.i}`).join('-')}` : ''}`);
  const beamMat = { ...rcMaterial(`rc-beam-${kind}`, D.beam), color: '#c9c4ba', textureKey: 'concrete-wall' };
  const colMat = { ...rcMaterial('rc-column', D.column), color: '#bdb8ad', textureKey: 'concrete-wall' };
  const jointMat = { ...rcMaterial('rc-joint', D.column), color: '#bdb8ad', textureKey: 'concrete-wall' };
  const plank = packMaterial('precast-plank', { density: plankDensity(P), E: P.concrete.Ecm, compression: 30e6, tension: 10e6, shear: 3e6, color: '#d6d1c4', textureKey: 'concrete-floor' });
  const anchor = packMaterial('foundation', { density: RC_DENSITY, E: 30e9, compression: 1e9, tension: 1e9, shear: 1e9, color: '#8d8a86', textureKey: 'concrete-wall' });
  const c = P.column / 2, frames = [0, P.depth], bonds = [];
  const bond = (i, j, mat, key) => { pk.bond(i, j, mat); bonds.push(key); };
  const joints = {}; // joints[f][k][i]
  for (let fz = 0; fz < 2; fz++) {
    const z = frames[fz]; joints[fz] = [];
    for (let i = 0; i < xs.length; i++) {
      // charged: the ground-floor column is a charge's support (a static box, calibration_charges.rs), not a chunk.
      const x = xs[i], gone = charged || removed.some((r) => r.i === i && r.frame === fz);
      const plate = pk.box({ min: [x - c, -0.1, z - c], max: [x + c, 0, z + c], material: anchor, type: 'footing', name: `footing-${fz}-${i}`, fixed: true });
      pk.box({ min: [x - c - 0.4, -1, z - c - 0.4], max: [x + c + 0.4, -0.1, z + c + 0.4], material: anchor, type: 'footing', name: `pad-${fz}-${i}`, fixed: true });
      let below = gone ? null : plate;
      for (let k = 0; k < P.storeys; k++) {
        const [y0, y1] = columnSpan(P, k);
        if (!(k === 0 && gone)) {
          const ym = (y0 + y1) / 2;
          const a = pk.box({ min: [x - c, y0, z - c], max: [x + c, ym, z + c], material: colMat, type: 'column', name: `column-${fz}-${i}-${k}a` });
          const b = pk.box({ min: [x - c, ym, z - c], max: [x + c, y1, z + c], material: colMat, type: 'column', name: `column-${fz}-${i}-${k}b` });
          if (below != null) bond(below, a, colMat, `column@${k}:${i}:bottom${fz ? '/N' : ''}`);
          bond(a, b, colMat, `column@${k}:${i}:mid${fz ? '/N' : ''}`);
          below = b;
        }
        // The joint: the column through the beams and the planks' depth.
        const jn = pk.box({ min: [x - c, y1, z - c], max: [x + c, floorY(P, k), z + c], material: jointMat, type: 'joint', name: `joint-${fz}-${i}-${k}` });
        if (below != null) bond(below, jn, colMat, `column@${k}:${i}:top${fz ? '/N' : ''}`);
        joints[fz][k] = joints[fz][k] ?? []; joints[fz][k][i] = jn; below = jn;
      }
    }
  }
  // Beams along x in each frame, chunked; transverse beams along z at each column line.
  const cuts = beamCuts(P), xbeams = {}, tbeams = [];
  const bedding = { ...packMaterial('mortar-bedding', { density: 2000, E: 10e9, compression: 10e6, tension: 0.6e6, shear: 1.0e6 }), color: '#bfb8aa' };
  for (let fz = 0; fz < 2; fz++) for (let k = 0; k < P.storeys; k++) for (let i = 0; i < xs.length - 1; i++) {
    const [y0, y1] = beamY(P, k), z = frames[fz], ids = [];
    for (let q = 0; q < cuts.length - 1; q++) ids.push(pk.box({ min: [xs[i] + cuts[q], y0, z - P.beam.b / 2], max: [xs[i] + cuts[q + 1], y1, z + P.beam.b / 2], material: beamMat, type: 'beam', name: `beam-${fz}-${k}-${i}-${q}` }));
    xbeams[`${fz}-${k}-${i}`] = ids;
    bond(joints[fz][k][i], ids[0], beamMat, `beam@${k + 1}:${(i * P.bay + cuts[0]).toFixed(2)}${fz ? '/N' : ''}`);
    for (let q = 0; q < ids.length - 1; q++) bond(ids[q], ids[q + 1], beamMat, `beam@${k + 1}:${(i * P.bay + cuts[q + 1]).toFixed(2)}${fz ? '/N' : ''}`);
    bond(ids.at(-1), joints[fz][k][i + 1], beamMat, `beam@${k + 1}:${(i * P.bay + cuts.at(-1)).toFixed(2)}${fz ? '/N' : ''}`);
  }
  for (let k = 0; k < P.storeys; k++) for (let i = 0; i < xs.length; i++) {
    const [y0, y1] = beamY(P, k), x = xs[i];
    const t = pk.box({ min: [x - P.beam.b / 2, y0, c], max: [x + P.beam.b / 2, y1, P.depth - c], material: beamMat, type: 'transverse-beam', name: `tbeam-${k}-${i}` });
    (tbeams[k] ??= [])[i] = t;
    bond(joints[0][k][i], t, beamMat, `tbeam@${k + 1}:${i}:0`); bond(t, joints[1][k][i], beamMat, `tbeam@${k + 1}:${i}:1`);
  }
  // A plank's bearing on frame fz's beam: a bond to every beam chunk under it.
  const bedOn = (pl, fz, k, i) => {
    const box = pk.boxes[pl];
    for (const id of xbeams[`${fz}-${k}-${i}`]) {
      const bb = pk.boxes[id];
      if (Math.min(box.max[0], bb.max[0]) - Math.max(box.min[0], bb.min[0]) > 1e-3) { pk.bond(id, pl, bedding); bonds.push(`bed@${k + 1}:${fz}`); }
    }
  };
  // Planks bedded in mortar on the beams (EN 1168 / EN 1992-1-1 10.9.5: a mortar bed, no ties):
  // a bond of the bearing patch with mortar-joint limits (EN 1996 values: tension 0.6 MPa, shear
  // 1.0 MPa) -- they carry the floor down, hold nothing together. And an in-situ strip over each
  // transverse beam, bedded the same way. (Resting by contact alone, the planks' first-tick contact
  // impulses loaded the frame as an impact.)
  for (let k = 0; k < P.storeys; k++) {
    const yt = floorY(P, k), yb = yt - P.plank.t;
    for (let i = 0; i < xs.length - 1; i++) {
      let x = xs[i] + c;
      const end = xs[i + 1] - c;
      while (x < end - 1e-6) {
        const w = Math.min(P.plank.w, end - x);
        const pl = pk.box({ min: [x + 0.005, yb, -P.beam.b / 2], max: [x + w - 0.005, yt, P.depth + P.beam.b / 2], material: plank, type: 'plank', name: `plank-${k}-${i}-${x.toFixed(1)}` });
        for (const fz of [0, 1]) bedOn(pl, fz, k, i);
        x += w;
      }
    }
    for (let i = 0; i < xs.length; i++) {
      const st = pk.box({ min: [xs[i] - P.beam.b / 2 + 0.005, yb, c + 0.005], max: [xs[i] + P.beam.b / 2 - 0.005, yt, P.depth - c - 0.005], material: plank, type: 'plank', name: `strip-${k}-${i}` });
      pk.bond(tbeams[k][i], st, bedding); bonds.push(`bed@${k + 1}:t${i}`);
    }
  }
  if (stair) stairTower(pk, P, anchor);
  // The charged columns' sections: [{line i, frame, box: [min, max]}].
  const supports = charged ? [0, 1].flatMap((fz) => xs.map((x, i) => ({ i, frame: fz, box: [[x - c, 0, frames[fz] - c], [x + c, columnSpan(P, 0)[1], frames[fz] + c]] }))) : [];
  return { pack: pk.build(), names: pk.names, bonds, D, supports };
}

/**
 * An exterior stair tower beyond the x 18 end: a dogleg per storey in the kit's
 * proportions (stairs.mjs townStaircase: 0.29 m going, equal risers of
 * 3.5 m / 20 = 175 mm, 1.25 m flights, a 1.35 m half landing; IRC R311.7
 * risers <= 196 mm), a floor landing level with every floor at the building's
 * edge, on four 250 mm columns. Boxes bonded to each other: each step a 0.4 m
 * deep block on the one below, each flight bonded to its landings. Its own
 * footing; it is not part of the frame's load path.
 */
function stairTower(pk, P, anchor) {
  const x0 = columnsX(P).at(-1) + P.column / 2 + 0.01, width = 1.25, gap = 0.06, run = 0.29, halfLanding = 1.35;
  const n = Math.round(P.storey / 2 / 0.18), rise = P.storey / (2 * n), well = 2 * width + 3 * gap, z0 = 1.0, deep = 0.55;
  // A reinforced stair: each step block bonds to the next over deep - rise (0.375 m) of the flight's
  // 1.25 m width, a waist reinforced at 0.5% (B500B): M_Rk ~ 270 kN m against ~13 kN m of a
  // flight's own weight over its 2.9 m going.
  const stair = { ...rcMaterial('rc-stair', rcRect({ b: width, h: deep - rise, cover: 0.04, As: 0.0025 * width * (deep - rise), concrete: P.concrete })), color: '#cfc9bc', textureKey: 'concrete-floor' };
  const zH = z0 + n * run, zEnd = zH + halfLanding, colW = 0.25;
  const level = (k) => (k === 0 ? 0 : floorY(P, k - 1));
  // Floor landings (the ground one an anchor), z in [z0 - 1.2, z0].
  const landings = [];
  for (let k = 0; k <= P.storeys; k++) {
    const y = level(k);
    landings.push(pk.box({ min: [x0, y - 0.2, z0 - 1.2], max: [x0 + well, y, z0], material: k === 0 ? anchor : stair, type: 'stair-landing', name: `stair-landing-${k}`, fixed: k === 0 }));
  }
  const front = [x0, x0 + well - colW].map((x) => ({ x, z: z0 - 1.2, below: landings[0] }));
  const back = [x0, x0 + well - colW].map((x) => ({ x, z: zEnd - colW, below: pk.box({ min: [x, -0.1, zEnd - colW], max: [x + colW, 0, zEnd], material: anchor, type: 'footing', name: 'stair-footing', fixed: true }), top: 0 }));
  const column = (cl, y0, y1, onto) => { const a = pk.box({ min: [cl.x, y0, cl.z], max: [cl.x + colW, y1, cl.z + colW], material: stair, type: 'stair-column', name: 'stair-column' }); pk.bond(cl.below, a, stair); pk.bond(a, onto, stair); cl.below = onto; };
  for (let k = 0; k < P.storeys; k++) {
    const L = level(k), H = L + P.storey / 2, L1 = level(k + 1);
    const half = pk.box({ min: [x0, H - 0.2, zH], max: [x0 + well, H, zEnd], material: stair, type: 'stair-landing', name: `half-landing-${k}` });
    const up = [], down = [];
    for (let s = 0; s < n; s++) { const t = L + (s + 1) * rise; up.push(pk.box({ min: [x0 + gap, t - deep, z0 + s * run], max: [x0 + gap + width, t, z0 + (s + 1) * run], material: stair, type: 'stair', name: `step-${k}-up-${s}` })); }
    for (let s = 0; s < n; s++) { const t = H + (s + 1) * rise; down.push(pk.box({ min: [x0 + 2 * gap + width, t - deep, zH - (s + 1) * run], max: [x0 + 2 * gap + 2 * width, t, zH - s * run], material: stair, type: 'stair', name: `step-${k}-down-${s}` })); }
    for (let s = 0; s < n - 1; s++) { pk.bond(up[s], up[s + 1], stair); pk.bond(down[s], down[s + 1], stair); }
    pk.bond(landings[k], up[0], stair); pk.bond(up.at(-1), half, stair); pk.bond(half, down[0], stair); pk.bond(down.at(-1), landings[k + 1], stair);
    for (const cl of back) column(cl, cl.top, H - 0.2, half), (cl.top = H);
    for (const cl of front) column(cl, L, L1 - 0.2, landings[k + 1]);
  }
}
