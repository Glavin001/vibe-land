/**
 * Calibration 1a: a continuous reinforced-concrete solid-slab viaduct, its
 * piers taken out one at a time (docs/calibration/bridge-piers.md).
 *
 * The bridge: a two-lane overbridge deck, a solid C35/45 slab b x h, integral
 * with its abutments and with wall piers (no bearings: the deck is cast into
 * the abutment backwalls and onto the piers, as short-span slab viaducts are
 * built, e.g. CIRIA C543 / BD 57 integral bridges). Reinforcement designed to
 * EN 1992-1-1 for the ULS envelope of self-weight and EN 1991-2 Load Model 1
 * (gamma 1.35 each; designAs), the same steel top and bottom along the
 * deck. Bare deck: surfacing, parapets and services stripped, as a bridge is
 * before its piers are taken out.
 *
 * As chunks (pack.mjs): deck segments `segment` long across its whole width
 * (each bond the full b x h section), wall piers of `pierChunks` chunks on a
 * footing anchor, abutment anchors the deck's end faces bond to. A removed pier
 * is its chunks gone; its footing stays.
 *
 * The hand calculation (frame2d.mjs): the deck a continuous member fixed at
 * the abutment faces, the piers columns fixed at their footings and rigidly
 * joined to it, gross concrete sections (EN 1992-1-1 5.4 linear analysis),
 * self-weight only. Each bond is checked where the engine checks it: the
 * deck's moment and shear at each segment joint (the faces of the pier
 * segment, not the pier centreline), each pier joint's fibre stresses.
 */
import { frame } from './frame2d.mjs';
import { Pack, cases } from './pack.mjs';
import { CONCRETE, RC_DENSITY, rcRect, rcMaterial, designAs, packMaterial } from './materials.mjs';

const G = 9.81;

export const BRIDGE = {
  key: 'bridge-slab',
  spans: [10.5, 10, 10, 10, 10, 10, 10.5],   // abutment face to pier centre, pier to pier (m)
  b: 8.0,           // deck width (m): two 3.5 m lanes + 0.5 m strips, bare
  h: 0.6,           // slab depth (m): span / 17, a usual continuous solid slab (span/15-20)
  cover: 0.06,      // to the bars' centre (m): 40 mm cover (EN 1992-1-1 4.4.1, XD3) + 20 mm half-bar
  segment: 1.0,     // deck chunk length (m)
  clearance: 6.0,   // ground to deck soffit (m)
  pier: { width: 6.0, thickness: 1.0, chunks: 3, rho: 0.002 },  // wall pier, 0.2% each face (EN 1992-1-1 9.6.2 minimum)
  abutment: 1.5,    // anchor block length (m)
  concrete: CONCRETE.C35,
};

/** Pier centrelines (x, m), the deck running from 0 to its length. */
export function piers(P = BRIDGE) {
  const x = []; let at = 0;
  for (const s of P.spans.slice(0, -1)) { at += s; x.push(at); }
  return x;
}
export const length = (P = BRIDGE) => P.spans.reduce((a, b) => a + b, 0);

/** EN 1991-2 Load Model 1 on the bare 8 m deck: lane 1 (3 m) q 9 kN/m^2 + tandem 2 x 300 kN, lane 2 2.5 kN/m^2 + 2 x 200 kN, remaining 2 m 2.5 kN/m^2 (4.3.2, alpha factors 1). */
export const LM1 = (P = BRIDGE) => ({ udl: 9e3 * 3 + 2.5e3 * (P.b - 3), tandem: 2 * 300e3 + 2 * 200e3, axleSpacing: 1.2 });

/** The frame model of the bridge with the piers `removed` (indices) gone. */
export function model(P = BRIDGE, removed = [], { deckSection, pierSection, w = deckSection.A * RC_DENSITY * G, extra = [], lumped = false } = {}) {
  const f = frame(), L = length(P), px = piers(P), yDeck = P.clearance + P.h / 2;
  // Deck nodes every segment joint and at every pier centreline, abutment faces fixed.
  // lumped: the weight as the engine has it, each chunk's at its centroid (else uniform).
  const xs = new Set();
  for (let x = 0; x <= L + 1e-9; x += P.segment) xs.add(+x.toFixed(6));
  if (lumped) for (let x = P.segment / 2; x < L; x += P.segment) xs.add(+x.toFixed(6));
  for (const x of px) xs.add(+x.toFixed(6));
  for (const e of extra) xs.add(+e.toFixed(6));
  const sorted = [...xs].sort((a, b) => a - b), node = new Map(sorted.map((x) => [x, f.node(x, yDeck)]));
  const deck = [];
  for (let k = 0; k < sorted.length - 1; k++) deck.push({ x0: sorted[k], x1: sorted[k + 1], m: f.member(node.get(sorted[k]), node.get(sorted[k + 1]), { E: deckSection.E, A: deckSection.A, I: deckSection.I, w: lumped ? 0 : w }) });
  if (lumped) for (let x = P.segment / 2; x < L; x += P.segment) f.load(node.get(+x.toFixed(6)), 0, -w * P.segment, 0);
  f.fix(node.get(0)); f.fix(node.get(+L.toFixed(6)));
  const columns = [];
  px.forEach((x, k) => {
    if (removed.includes(k)) return;
    const base = f.node(x, 0);
    f.fix(base);
    const wc = pierSection.A * RC_DENSITY * G, hc = P.clearance / P.pier.chunks;
    if (!lumped) { columns.push({ k, x, m: f.member(base, node.get(+x.toFixed(6)), { E: pierSection.E, A: pierSection.A, I: pierSection.I, w: wc }) }); return; }
    // Lumped: a node at each pier chunk's centre carrying its weight; the column as pieces.
    let below = base; const parts = [];
    for (let j = 0; j < P.pier.chunks; j++) { const c = f.node(x, (j + 0.5) * hc); parts.push({ s0: j === 0 ? 0 : (j - 0.5) * hc, m: f.member(below, c, { E: pierSection.E, A: pierSection.A, I: pierSection.I }) }); f.load(c, 0, -wc * hc, 0); below = c; }
    parts.push({ s0: (P.pier.chunks - 0.5) * hc, m: f.member(below, node.get(+x.toFixed(6)), { E: pierSection.E, A: pierSection.A, I: pierSection.I }) });
    columns.push({ k, x, parts });
  });
  return { f, deck, columns, node, sorted };
}

/** Moment and shear along the deck at x (from a solved model). */
function deckAt(r, deck, x) {
  const e = deck.find((d) => x >= d.x0 - 1e-9 && x <= d.x1 + 1e-9);
  return r.at(e.m, x - e.x0);
}

/** The bridge's sections: the deck's reinforcement designed for self-weight + LM1 (ULS envelope). */
export function design(P = BRIDGE) {
  const trial = rcRect({ b: P.b, h: P.h, cover: P.cover, As: 0.01 * P.b * P.h, concrete: P.concrete });
  const pierGross = { A: P.pier.width * P.pier.thickness, I: P.pier.width * P.pier.thickness ** 3 / 12, E: P.concrete.Ecm };
  const intact = (w, extraLoads) => {
    const m = model(P, [], { deckSection: trial, pierSection: pierGross, w });
    if (extraLoads) extraLoads(m);
    const r = m.f.solve();
    return m.sorted.map((x) => ({ x, M: deckAt(r, m.deck, x).M }));
  };
  const g = intact(trial.A * RC_DENSITY * G);
  // LM1 UDL span by span (patterned: each span's own contribution, summed by sign), tandem at each span's middle.
  const L = length(P), px = [0, ...piers(P), L], lm = LM1(P);
  const udl = [];
  for (let s = 0; s < P.spans.length; s++) {
    const m = model(P, [], { deckSection: trial, pierSection: pierGross, w: 0 });
    for (const d of m.deck) if (d.x0 >= px[s] - 1e-9 && d.x1 <= px[s + 1] + 1e-9) m.f.members[d.m].w = lm.udl;
    const r = m.f.solve();
    udl.push(m.sorted.map((x) => deckAt(r, m.deck, x).M));
  }
  const tandem = [];
  for (let s = 0; s < P.spans.length; s++) {
    const mid = (px[s] + px[s + 1]) / 2, axles = [mid - lm.axleSpacing / 2, mid + lm.axleSpacing / 2];
    const m = model(P, [], { deckSection: trial, pierSection: pierGross, w: 0, extra: axles });
    for (const a of axles) m.f.load(m.node.get(+a.toFixed(6)), 0, -lm.tandem / 2, 0);
    const r = m.f.solve();
    tandem.push(new Map(m.sorted.map((x) => [x, deckAt(r, m.deck, x).M])));
  }
  let sag = 0, hog = 0;
  g.forEach(({ x, M }, i) => {
    const up = udl.reduce((t, u) => t + Math.max(0, u[i]), 0), down = udl.reduce((t, u) => t + Math.min(0, u[i]), 0);
    const ts = tandem.map((t) => t.get(x) ?? 0);
    sag = Math.max(sag, 1.35 * M + 1.35 * (up + Math.max(0, ...ts)));
    hog = Math.min(hog, 1.35 * M + 1.35 * (down + Math.min(0, ...ts)));
  });
  const M_Ed = Math.max(sag, -hog), As = designAs(M_Ed, P.b, P.h - P.cover, P.concrete);
  const deckSection = rcRect({ b: P.b, h: P.h, cover: P.cover, As, concrete: P.concrete });
  const pierSection = rcRect({ b: P.pier.width, h: P.pier.thickness, cover: 0.06, As: P.pier.rho * P.pier.width * P.pier.thickness, concrete: P.concrete });
  return { M_Ed_sag: sag, M_Ed_hog: hog, As, deckSection, pierSection, lm };
}

/**
 * The hand calculation for the bridge with `removed` piers out: every bond the
 * engine has, its utilisation by the engine's own failure law against the
 * section's characteristic capacity. `bendingModulus(section)` is the section
 * modulus the engine's configuration uses (the true S with section bending).
 */
export function check(P, removed, D, { bendingModulus = (sec) => sec.S, lumped = false } = {}) {
  const m = model(P, removed, { deckSection: D.deckSection, pierSection: D.pierSection, lumped });
  const r = m.f.solve(), L = length(P), out = [];
  const columnAt = (c, s) => {
    if (!c.parts) return r.at(c.m, s);
    // Just below a chunk centre's node belongs to the piece under it (the joints are between centres).
    let part = c.parts[0];
    for (const p of c.parts) if (s >= p.s0 - 1e-9) part = p;
    return r.at(part.m, s - part.s0);
  };
  const deckMat = rcMaterial('deck', D.deckSection), pierMat = rcMaterial('pier', D.pierSection);
  const fibre = (N, M, sec, mat) => {
    const sb = Math.abs(M) / bendingModulus(sec), sn = N / sec.A;   // N tension +
    return { tension: Math.max(0, sn + sb) / mat.tensionElastic, compression: Math.max(0, sb - sn) / mat.compressionElastic };
  };
  for (let x = 0; x <= L + 1e-9; x += P.segment) {
    const { N, V, M } = deckAt(r, m.deck, x);
    const u = fibre(N, M, D.deckSection, deckMat), shear = Math.abs(V) / D.deckSection.A / deckMat.shearElastic;
    out.push({ member: x < 1e-9 || x > L - 1e-9 ? 'deck-abutment' : 'deck', x: +x.toFixed(3), M, V, N, u: Math.max(u.tension, u.compression, shear), flexure: Math.max(u.tension, u.compression), shear });
  }
  const hc = P.clearance / P.pier.chunks;
  for (const c of m.columns) {
    const len = P.clearance + P.h / 2;
    for (let j = 0; j <= P.pier.chunks; j++) {
      const s = j * hc, { N, V, M } = columnAt(c, s);
      const u = fibre(N, M, D.pierSection, pierMat), shear = Math.abs(V) / D.pierSection.A / pierMat.shearElastic;
      out.push({ member: j === 0 ? 'pier-footing' : j === P.pier.chunks ? 'pier-deck' : 'pier', pier: c.k, x: c.x, y: s, M, V, N, u: Math.max(u.tension, u.compression, shear), flexure: Math.max(u.tension, u.compression), shear, len });
    }
  }
  const worst = out.reduce((a, b) => (b.u > a.u ? b : a));
  return { bonds: out, worst, deflection: Math.min(...m.sorted.map((x) => r.u[m.node.get(x) * 3 + 1])) };
}

/** Build the bridge pack with the piers `removed` gone. */
export function build(P = BRIDGE, removed = [], D = design(P)) {
  const pk = new Pack(`${P.key}${removed.length ? `-no-pier-${removed.map((k) => k + 1).join('-')}` : ''}`);
  const deckMat = { ...rcMaterial('rc-deck', D.deckSection), color: '#c9c4ba', textureKey: 'concrete-floor' };
  const pierMat = { ...rcMaterial('rc-pier', D.pierSection), color: '#b8b3a8', textureKey: 'concrete-wall' };
  const anchor = packMaterial('foundation', { density: RC_DENSITY, E: P.concrete.Ecm, compression: 1e9, tension: 1e9, shear: 1e9, color: '#8d8a86', textureKey: 'concrete-wall' });
  const L = length(P), y0 = P.clearance, y1 = y0 + P.h, z0 = -P.b / 2, z1 = P.b / 2;
  const deck = [];
  for (let x = 0, k = 0; x < L - 1e-9; x += P.segment, k++) deck.push(pk.box({ min: [x, y0, z0], max: [Math.min(L, x + P.segment), y1, z1], material: deckMat, type: 'deck', name: `deck-${k}` }));
  const info = [];
  const bond = (i, j, mat, what) => { pk.bond(i, j, mat); info.push(what); };
  for (let k = 0; k < deck.length - 1; k++) bond(deck[k], deck[k + 1], deckMat, { member: 'deck', x: +((k + 1) * P.segment).toFixed(3) });
  // Abutments: the backwall face the deck is cast into is a thin anchor plate (a bond's compliance
  // runs centroid to centroid, so an anchor's centroid deep inside a massive block would add a
  // flexible stub of deck to the clamp: 0.75 m of it read the fixed-end moment 15% low); the
  // abutment's mass behind it is a separate, unbonded anchor.
  const T = 0.1;
  const a0 = pk.box({ min: [-T, y0, z0], max: [0, y1, z1], material: anchor, type: 'abutment', name: 'abutment-west-face', fixed: true });
  const a1 = pk.box({ min: [L, y0, z0], max: [L + T, y1, z1], material: anchor, type: 'abutment', name: 'abutment-east-face', fixed: true });
  pk.box({ min: [-P.abutment, y0 - 1, z0 - 0.5], max: [-T, y1 + 0.3, z1 + 0.5], material: anchor, type: 'abutment', name: 'abutment-west', fixed: true });
  pk.box({ min: [L + T, y0 - 1, z0 - 0.5], max: [L + P.abutment, y1 + 0.3, z1 + 0.5], material: anchor, type: 'abutment', name: 'abutment-east', fixed: true });
  bond(a0, deck[0], deckMat, { member: 'deck-abutment', x: 0 }); bond(deck.at(-1), a1, deckMat, { member: 'deck-abutment', x: +L.toFixed(3) });
  const t = P.pier.thickness, wz = P.pier.width / 2, hc = P.clearance / P.pier.chunks;
  piers(P).forEach((x, k) => {
    // The pier's base on its footing: a thin anchor plate (see the abutments), the footing below it unbonded.
    const footing = pk.box({ min: [x - t / 2, -T, -wz], max: [x + t / 2, 0, wz], material: anchor, type: 'footing', name: `footing-${k + 1}-face`, fixed: true });
    pk.box({ min: [x - t / 2 - 0.5, -1, -wz - 0.5], max: [x + t / 2 + 0.5, -T, wz + 0.5], material: anchor, type: 'footing', name: `footing-${k + 1}`, fixed: true });
    if (removed.includes(k)) return;
    let below = footing;
    for (let j = 0; j < P.pier.chunks; j++) {
      const c = pk.box({ min: [x - t / 2, j * hc, -wz], max: [x + t / 2, (j + 1) * hc, wz], material: pierMat, type: 'pier', name: `pier-${k + 1}-${j}` });
      bond(below, c, pierMat, { member: j === 0 ? 'pier-footing' : 'pier', pier: k, x, y: +(j * hc).toFixed(3) }); below = c;
    }
    const over = deck.find((d) => Math.abs(pk.s.nodes[d].centroid.x - x) < 1e-6);
    if (over == null) throw Error(`pier ${k + 1} at ${x} is not under a deck segment's centre`);
    bond(below, over, pierMat, { member: 'pier-deck', pier: k, x, y: P.clearance });
  });
  return { pack: pk.build(), names: pk.names, bonds: info };
}
