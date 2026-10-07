/**
 * Calibration 1b (docs/calibration/truss-members.md): a glulam Pratt truss
 * footbridge, its members cut one at a time.
 *
 * The bridge: two Pratt trusses 3 m apart carry a 3 m deck over 24 m (six
 * 4 m panels, 3 m deep, span/8). This is one of them, with its half of the
 * deck and of a crowd hung at its bottom panel points as kentledge (the load a
 * cross beam brings each panel point). GL28h (EN 14080) members, one width
 * (200 mm) across the plane; chords continuous through the joints (glulam to
 * glulam), web members and end posts in slotted-in steel plates with 12 mm
 * dowels (EN 1995-1-1 8.2.3), the number of dowels designed for the member's
 * ULS force. Out-of-plane buckling and lateral restraint are outside the
 * engine (rigid chunks do not buckle) and outside this calibration: the top
 * chord is taken as braced (a U-frame through the cross beams).
 *
 * Loads (per truss): self-weight; deck 1.5 kPa (timber deck on cross beams);
 * crowd q_fk = 2.0 + 120/(L + 30) kPa (EN 1991-2 eq. 5.1) = 4.22 kPa; each
 * over half the 3 m deck. ULS design 1.35 G + 1.35 Q (EN 1990 Annex A2).
 *
 * The hand calculation (frame2d.mjs): the truss as a rigid-jointed plane
 * frame (its members' own E A and E I between joint faces, the joints rigid,
 * dowel slip neglected -- see the write-up) and, for the intact truss, as
 * pin-jointed (method of joints) for comparison. Each bond is checked where
 * the engine checks it: member forces at the joint faces and at mid-member.
 */
import { frame } from './frame2d.mjs';
import { planar } from './planar.mjs';
import { packMaterial, GL28H } from './materials.mjs';

const G = 9.81;
/**
 * The engine's `elastic` (what is carried indefinitely) for this structure:
 * k_mod for the governing load's duration (EN 1995-1-1 Table 3.1, glulam,
 * service class 2): a crowd is a short-term action, 0.9 (the town kit's
 * houses carry their own weight: permanent, 0.6).
 */
export const KMOD = 0.9;

export const TRUSS = {
  key: 'truss-pratt',
  panels: 6, panel: 4.0, height: 3.0, width: 0.2,
  chord: 0.28, web: 0.2, post: 0.28,            // in-plane depths (m), GL28h, all 200 wide
  deck: 1.5e3, crowd: null, deckWidth: 3.0,      // kPa loads (crowd from EN 1991-2 5.1)
  // Both bearings fixed against sliding (pinned): the stage cannot give a bearing freedom to
  // slide (a bond to an anchor holds every direction), so the calibration bridge has two fixed
  // bearings, as some short footbridges do; an expansion bearing is an engine gap (see the write-up).
  support: 'pinned-pinned',
  dowel: { d: 0.012, fu: 360e6 },                // S235 dowels (EN 10025), f_u 360 MPa
};
export const crowd = (L) => (2.0 + 120 / (L + 30)) * 1e3;

/** Joints and members of the Pratt truss: bottom B0..B6, top T1..T5, end posts, verticals, diagonals sloping down to midspan. */
export function geometry(P = TRUSS) {
  const n = P.panels, joints = [], members = [];
  for (let i = 0; i <= n; i++) joints.push({ id: `B${i}`, x: i * P.panel, y: 0 });
  for (let i = 1; i < n; i++) joints.push({ id: `T${i}`, x: i * P.panel, y: P.height });
  const J = (id) => joints.findIndex((j) => j.id === id);
  for (let i = 0; i < n; i++) members.push({ a: J(`B${i}`), b: J(`B${i + 1}`), type: 'bottom-chord', depth: P.chord });
  for (let i = 1; i < n - 1; i++) members.push({ a: J(`T${i}`), b: J(`T${i + 1}`), type: 'top-chord', depth: P.chord });
  members.push({ a: J('B0'), b: J('T1'), type: 'end-post', depth: P.post }, { a: J(`B${n}`), b: J(`T${n - 1}`), type: 'end-post', depth: P.post });
  for (let i = 1; i < n; i++) members.push({ a: J(`B${i}`), b: J(`T${i}`), type: 'vertical', depth: P.web });
  // Pratt: diagonals in tension under gravity, from the top joint nearer the support down towards midspan.
  for (let i = 1; i < n / 2; i++) members.push({ a: J(`T${i}`), b: J(`B${i + 1}`), type: 'diagonal', depth: P.web }, { a: J(`T${n - i}`), b: J(`B${n - i - 1}`), type: 'diagonal', depth: P.web });
  members.forEach((m) => { m.id = `${joints[m.a].id}-${joints[m.b].id}`; });
  return { joints, members, J };
}

/** Panel-point loads (N) per truss: deck + crowd over its half deck width, a panel each; self-weight is the members' own. */
export function panelLoad(P = TRUSS, { crowdFactor = 1 } = {}) {
  const L = P.panels * P.panel, q = P.deck + crowdFactor * (P.crowd ?? crowd(L));
  return q * (P.deckWidth / 2) * P.panel;
}

/** The frame model with members `removed` (ids); pinned: every member end released (a pin-jointed truss). */
export function model(P = TRUSS, removed = [], { pinned = false, loadFactor = 1, gFactor = 1, crowdFactor = 1 } = {}) {
  const { joints, members, J } = geometry(P), f = frame(), node = joints.map((j) => f.node(j.x, j.y));
  const E = GL28H.E, b = P.width, rho = GL28H.density;
  const kept = members.filter((m) => !removed.includes(m.id));
  const ms = kept.map((m) => ({ ...m, k: f.member(node[m.a], node[m.b], { E, A: b * m.depth, I: b * m.depth ** 3 / 12, w: gFactor * b * m.depth * rho * G, release: pinned ? [true, true] : [false, false] }) }));
  // Supports: B0 pinned, B6 on a roller (as built); `fixed`: both bonded (the engine's anchors).
  const far = P.support === 'fixed' ? 'xyz' : P.support === 'pinned-pinned' ? 'xy' : 'y';
  f.fix(node[J('B0')], P.support === 'fixed' ? 'xyz' : 'xy'); f.fix(node[J(`B${P.panels}`)], far);
  const Pn = loadFactor * panelLoad(P, { crowdFactor });
  for (let i = 1; i < P.panels; i++) f.load(node[J(`B${i}`)], 0, -Pn, 0);
  return { f, ms, joints, node };
}

/** Member end and mid forces of a solved model: {id: {N0, M0, V0, Nm, Mm, N1, M1, V1, L}} (N tension +). */
export function forces(P, removed, opts) {
  const m = model(P, removed, opts), r = m.f.solve(), out = {};
  // A mechanism solves to nonsense rather than failing outright in floating point: metres of displacement.
  if (opts?.pinned && Math.max(...Array.from(r.u, Math.abs)) > 0.5) throw Error('mechanism');
  for (const q of m.ms) {
    const A = m.joints[q.a], B = m.joints[q.b], L = Math.hypot(B.x - A.x, B.y - A.y);
    out[q.id] = { L, type: q.type, depth: q.depth, start: r.at(q.k, 0), mid: r.at(q.k, L / 2), end: r.at(q.k, L) };
  }
  return out;
}

/**
 * EN 1995-1-1 8.2.3 (thick slotted-in steel plate, double shear, eq. 8.11 f-h)
 * and 8.5.1: one dowel's characteristic shear capacity parallel to the grain,
 * per shear plane, in a 200 mm GL28h member (side timber t1 = (200 - 10)/2).
 */
export function dowel(P = TRUSS) {
  const d = P.dowel.d * 1e3, rhok = 425, t1 = (P.width * 1e3 - 10) / 2;
  const fh = 0.082 * (1 - 0.01 * d) * rhok, My = 0.3 * P.dowel.fu / 1e6 * d ** 2.6;
  const f = fh * t1 * d, g = fh * t1 * d * (Math.sqrt(2 + 4 * My / (fh * d * t1 ** 2)) - 1), h = 2.3 * Math.sqrt(My * fh * d);
  return { fh, My, perPlane: Math.min(f, g, h), perDowel: 2 * Math.min(f, g, h), modes: { f, g, h } };
}

/**
 * A web member's connection: n dowels for its ULS force (k_mod 0.9 short-term
 * crowd, gamma_M 1.3, EN 1995-1-1 2.4.1), effective number n^0.9 for a row
 * (8.5.1.1 with a1 >= 13 d), at least 4; its characteristic capacity R_k.
 * As an engine material: tension = shear = R_k / A over the member's end
 * section; compression the glulam's end bearing f_c,0,g,k (the member bears
 * on the plate); stiffness the dowels' slip modulus (7.1: K_ser = rho_m^1.5 d
 * / 23 per shear plane, doubled steel-to-timber).
 */
export function connection(F_Ed, depth, P = TRUSS) {
  const dw = dowel(P), Fd = dw.perDowel * 0.9 / 1.3, n = Math.max(4, Math.ceil(Math.abs(F_Ed) / Fd));
  const nef = n ** 0.9, Rk = nef * dw.perDowel, A = P.width * depth;
  const Kser = 2 * 2 * (460 ** 1.5 * P.dowel.d * 1e3 / 23) * 1e3; // N/m per dowel, two shear planes, steel-to-timber
  return { n, nef, Rk, A, k: n * Kser };
}

/** The engine materials: GL28H for members (bending f_m, shear f_v; sustained k_mod 0.6), one connection material per web member. */
export function materials(P = TRUSS) {
  const member = packMaterial('gl28h', { density: GL28H.density, E: GL28H.E, compression: GL28H.fc0, tension: GL28H.fm, shear: GL28H.fv, sustained: { compression: KMOD, tension: KMOD, shear: KMOD }, color: '#c49a6c', textureKey: 'aged-timber' });
  return { member };
}

/** ULS forces of the intact truss (rigid joints), for the connection design. */
export function design(P = TRUSS) {
  const g = forces(P, [], { gFactor: 1.35, loadFactor: 0 }), q = forces(P, [], { gFactor: 0, loadFactor: 1 });
  // Panel loads split: deck is permanent, crowd variable; both factored 1.35.
  const deckOnly = forces(P, [], { gFactor: 0, crowdFactor: 0 });
  const out = {};
  for (const id of Object.keys(g)) {
    const pick = (o) => Math.max(Math.abs(o.start.N), Math.abs(o.end.N));
    out[id] = 1.35 * (pick(g[id]) / 1.35 + pick(q[id]));
  }
  return { F_Ed: out, deckOnly };
}

/**
 * Build the bridge with members `removed` (ids, cut in both trusses): two
 * trusses (S at z -1.5, N at +1.5), each on two bearing pads, joined at every
 * bottom panel point by a cross beam that carries the deck and the crowd
 * between them (its mass is that load: 2 x the panel load inside, 1 x at the
 * ends) and makes the U-frames that hold the trusses upright.
 */
export function build(P = TRUSS, removed = []) {
  const { joints, members } = geometry(P), D = design(P), M = materials(P);
  const steel = packMaterial('steel-joint', { density: 1200, E: 210e9, compression: 355e6, tension: 355e6, shear: 205e6, color: '#6f7a80', textureKey: 'metal', metalness: 0.6 });
  const anchor = packMaterial('foundation', { density: 2400, E: 30e9, compression: 1e9, tension: 1e9, shear: 1e9, color: '#8d8a86', textureKey: 'concrete-wall' });
  const deckBeam = packMaterial('cross-beam-and-deck', { density: 2400, E: 12.6e9, compression: 1e9, tension: 1e9, shear: 1e9, color: '#b08a5c', textureKey: 'aged-timber' });
  const conn = {}, key = `${P.key}${removed.length ? `-no-${removed.join('-')}` : ''}`;
  const plane = (zc, prefix, pk) => {
    const t = planar({ width: P.width, z0: zc - P.width / 2, key });
    // Bottom joints get a flat underside 0.3 m either side of the node (a bearing plate, a cross-beam seat).
    const ids = joints.map((j) => t.joint(j.id, j.x, j.y, { material: steel, type: j.id.startsWith('T') ? 'top-joint' : 'bottom-joint', minRadius: 0.2,
      extra: j.id.startsWith('B') ? [[j.x - 0.3, j.y - P.chord / 2], [j.x + 0.3, j.y - P.chord / 2]] : [] }));
    for (const m of members) {
      if (removed.includes(m.id)) continue;
      let ends = [M.member, M.member];
      if (m.type !== 'bottom-chord' && m.type !== 'top-chord') {
        const c = connection(D.F_Ed[m.id], m.depth, P); conn[m.id] = c;
        // The dowel group's slip stiffness k as a bond E A / L over a 0.5 m spring.
        const L = 0.5;
        const mat = packMaterial(`dowels-${c.n}x${(P.dowel.d * 1e3).toFixed(0)}-${m.depth}`, { density: GL28H.density, E: c.k * L / c.A, compression: GL28H.fc0, tension: c.Rk / c.A, shear: c.Rk / c.A, sustained: { compression: KMOD, tension: KMOD, shear: KMOD }, color: '#c49a6c', textureKey: 'aged-timber' });
        ends = [mat, mat];
      }
      t.member(ids[m.a], ids[m.b], { depth: m.depth, material: M.member, ends, chunks: 2, type: m.type, id: m.id });
    }
    return t.build({ jointMaterial: steel, pk, prefix });
  };
  const S = plane(-1.5, 'S:'), N = plane(1.5, 'N:', S.pk), pk = S.pk, bonds = [...S.bonds, ...N.bonds];
  const underside = (side, j) => { const poly = side.polygons[j], y = Math.min(...poly.map((q) => q[1])), xs = poly.filter((q) => Math.abs(q[1] - y) < 1e-9).map((q) => q[0]); return { y, x0: Math.min(...xs), x1: Math.max(...xs) }; };
  const zi = 1.5 - P.width / 2;
  for (let i = 0; i <= P.panels; i++) {
    const ji = joints.findIndex((q) => q.id === `B${i}`), { y, x0, x1 } = underside(S, ji), x = (x0 + x1) / 2;
    // Bearings: a thin anchor pad under each end joint of each truss, bonded across its underside.
    if (i === 0 || i === P.panels) {
      for (const [side, zc] of [[S, -1.5], [N, 1.5]]) {
        const n = side.nodeOf[ji];
        const pad = pk.box({ min: [x0, y - 0.1, zc - P.width / 2], max: [x1, y, zc + P.width / 2], material: anchor, type: 'bearing', name: `bearing-${side === S ? 'S' : 'N'}-B${i}`, fixed: true });
        pk.rawBond(pad, n, { centroid: [x, y, zc], normal: [0, 1, 0], area: (x1 - x0) * P.width, material: steel });
        bonds.push({ member: `bearing-${side === S ? 'S' : 'N'}-B${i}`, end: 0, type: 'bearing' });
        pk.box({ min: [x0 - 0.3, y - 1.1, zc - 0.6], max: [x1 + 0.3, y - 0.1, zc + 0.6], material: anchor, type: 'abutment', name: `abutment-${side === S ? 'S' : 'N'}-B${i}`, fixed: true });
      }
    }
    // The cross beam between the two bottom joints, its section within each joint's inner face.
    const load = (i === 0 || i === P.panels ? 1 : 2) * panelLoad(P), b = 0.24, h = Math.min(0.3, P.chord);
    const cb = pk.box({ min: [x - b / 2, -h / 2, -zi], max: [x + b / 2, h / 2, zi], material: deckBeam, type: 'cross-beam', name: `cross-beam-B${i}` });
    pk.s.nodes[cb].mass = Math.round(load / G * 1e3) / 1e3;
    for (const [side, zf, sgn] of [[S, -zi, 1], [N, zi, -1]]) {
      pk.rawBond(side.nodeOf[ji], cb, { centroid: [x, 0, zf], normal: [0, 0, sgn], area: b * h, material: steel });
      bonds.push({ member: `cross-beam-${side === S ? 'S' : 'N'}-B${i}`, end: 0, type: 'cross-beam' });
    }
  }
  return { pack: pk.build(), names: pk.names, bonds, radius: S.radius, conn, D };
}

/**
 * The hand calculation per removal: every bond the engine has, its
 * utilisation by the engine's failure law (fibre tension N/A + M/S, fibre
 * compression M/S - N/A, shear V/A) against the member's or connection's
 * capacity -- `limit`: 'sustained' (k_mod, the engine's elastic) or 'short'
 * (characteristic). Member end bonds sit at the joint faces (`faces`: each
 * joint's radius from build), mid bonds at mid-member.
 */
export function check(P, removed, { faces, limit = 'sustained', bendingModulus = (b, h) => b * h * h / 6 } = {}) {
  const f = forces(P, removed), D = design(P), k = limit === 'sustained' ? KMOD : 1, out = [];
  const { joints, members } = geometry(P);
  for (const m of members) {
    if (removed.includes(m.id)) continue;
    const q = f[m.id], b = P.width, A = b * m.depth, S = bendingModulus(b, m.depth), L = q.L;
    const web = m.type !== 'bottom-chord' && m.type !== 'top-chord', c = web ? connection(D.F_Ed[m.id], m.depth, P) : null;
    const lim = (joint) => joint && web ? { t: c.Rk / A, c: GL28H.fc0, v: c.Rk / A } : { t: GL28H.fm, c: GL28H.fc0, v: GL28H.fv };
    const at = (s, joint, key) => {
      const r = s <= L / 2 ? (s < 1e-9 ? 'start' : 'mid') : 'end';
      const F = s < 1e-9 || Math.abs(s - L) < 1e-9 || Math.abs(s - L / 2) < 1e-9 ? q[r] : null;
      return F;
    };
    const r0 = faces?.[m.a] ?? 0, r1 = faces?.[m.b] ?? 0;
    const model = forcesAlong(P, removed);
    for (const [s, joint, key] of [[r0, true, `${m.id}:0`], [L / 2, false, `${m.id}:mid`], [L - r1, true, `${m.id}:1`]]) {
      const F = model(m.id, s), l = lim(joint), sn = F.N / A, sb = Math.abs(F.M) / S;
      const u = Math.max(Math.max(0, sn + sb) / (k * l.t), Math.max(0, sb - sn) / (k * l.c), Math.abs(F.V) / A / (k * l.v));
      out.push({ key, member: m.id, type: m.type, joint, s, N: F.N, V: F.V, M: F.M, u });
    }
  }
  return { bonds: out, worst: out.reduce((a, b) => (b.u > a.u ? b : a)) };
}

/** Internal forces along members of the rigid-jointed model (memoised per removal). */
const along = new Map();
export function forcesAlong(P, removed) {
  const key = JSON.stringify([P.key, removed, P.support]);
  if (!along.has(key)) {
    const m = model(P, removed), r = m.f.solve(), by = new Map(m.ms.map((q) => [q.id, q]));
    along.set(key, (id, s) => r.at(by.get(id).k, s));
  }
  return along.get(key);
}
