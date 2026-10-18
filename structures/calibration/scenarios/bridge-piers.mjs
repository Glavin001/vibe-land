/**
 * Scenario 1a (docs/calibration/bridge-piers.md): the seven-span RC slab
 * viaduct (src/bridge-slab.mjs) with its piers taken out one at a time.
 *
 * Order: pier 2, then pier 5 (each leaves a 20 m span between two piers,
 * continuous both sides), then pier 3 beside the first gap (a 30 m span), then
 * pier 4 (40 m), then every pier (the whole 71 m between the abutments). The
 * piers next to the abutments go last: a gap against an integral abutment
 * loads its fixed end hardest (0.91 for pier 1 alone, against 0.69 for pier 2).
 */
import * as B from '../src/bridge-slab.mjs';
import { BENDING } from '../src/configs.mjs';
import { stateOf } from '../src/scenario.mjs';

export const id = 'bridge-piers';
export const title = 'Calibration: RC slab viaduct, piers removed one at a time';
export const ticks = 600;
export const spacing = 24;
/**
 * The band (+-15% on utilisation) a prediction carries: the engine's bonds sit
 * at 1 m joints, a lumped weight per chunk (0.1% off the uniform load here),
 * a solve converged to 1e-3 of its forces in FP32 (0.4%), shear stiffness E A
 * for G A_v (a 10 m span's shear deflection ~1% of its bending), and the
 * concrete's own scatter -- characteristic strength is a 5% fractile and the
 * mean reinforcement yield is 1.1-1.15 of f_yk (JCSS). A case inside the band
 * may go either way.
 */
export const band = 0.15;
const STEPS = [
  { id: 'step0', label: 'As built: 7 spans of 10 m', removed: [] },
  { id: 'step1', label: 'Pier 2 out: a 20 m span', removed: [1] },
  { id: 'step2', label: 'Piers 2 and 5 out: two 20 m spans', removed: [1, 4] },
  { id: 'step3', label: 'Piers 2, 3, 5 out: a 30 m span', removed: [1, 2, 4] },
  { id: 'step4', label: 'Piers 2-5 out: a 50 m span', removed: [1, 2, 3, 4] },
  { id: 'step5', label: 'Every pier out: 71 m between the abutments', removed: [0, 1, 2, 3, 4, 5] },
];

export function hand() {
  const D = B.design(B.BRIDGE), s = D.deckSection, p = D.pierSection;
  const kN = (x) => +(x / 1e3).toFixed(0);
  return {
    bridge: { spans: B.BRIDGE.spans, length: B.length(B.BRIDGE), b: B.BRIDGE.b, h: B.BRIDGE.h, clearance: B.BRIDGE.clearance, pier: B.BRIDGE.pier, segment: B.BRIDGE.segment },
    design: { M_Ed_sag_kNm: kN(D.M_Ed_sag), M_Ed_hog_kNm: kN(D.M_Ed_hog), As_per_face_cm2: +(D.As * 1e4).toFixed(0), rho_pct: +(s.rho * 100).toFixed(2),
      LM1: { udl_kN_per_m: kN(D.lm.udl), tandem_kN: kN(D.lm.tandem) } },
    deck: { A: s.A, S: s.S, I: s.I, M_Rk_kNm: kN(s.M_Rk), M_yk_kNm: kN(s.M_yk), V_Rk_kN: kN(s.V_Rk), N_Rk_MN: +(s.N_Rk / 1e6).toFixed(1), xOverD: +s.xOverD.toFixed(3),
      selfWeight_kN_per_m: kN(s.A * 25e3), S_gain: +BENDING.gain(s).toFixed(3) },
    pier: { A: p.A, S: p.S, M_Rk_kNm: kN(p.M_Rk), N_Rk_MN: +(p.N_Rk / 1e6).toFixed(1), V_Rk_kN: kN(p.V_Rk), S_gain: +BENDING.gain(p).toFixed(3) },
  };
}

export const models = { real: 'true section moduli (the engineering prediction)', gain: "the default stage's capped square-patch bending gain" };

export function cases() {
  const D = B.design(B.BRIDGE);
  return STEPS.map((st) => {
    const { pack, names, bonds } = B.build(B.BRIDGE, st.removed, D);
    const predictions = {};
    for (const [model, bendingModulus] of Object.entries(BENDING)) {
      const c = B.check(B.BRIDGE, st.removed, D, { bendingModulus });
      const key = (b) => (b.member.startsWith('pier') ? `${b.member}@${b.pier}:${b.y}` : `${b.member}@${b.x}`);
      const ranked = [...c.bonds].sort((a, b) => b.u - a.u);
      predictions[model] = {
        state: stateOf(c.worst.u, band), u: +c.worst.u.toFixed(3), worst: key(c.worst),
        deflection_mm: +(c.deflection * 1e3).toFixed(1),
        over: ranked.filter((b) => b.u >= 1 - band).map((b) => ({ key: key(b), u: +b.u.toFixed(3), M_kNm: +(b.M / 1e3).toFixed(0), V_kN: +(b.V / 1e3).toFixed(0) })),
        bonds: Object.fromEntries(c.bonds.map((b) => [key(b), +b.u.toFixed(4)])),
      };
    }
    const key = (b) => (b.member.startsWith('pier') ? `${b.member}@${b.pier}:${b.y}` : `${b.member}@${b.x}`);
    return { id: st.id, label: st.label, removed: st.removed.map((k) => `pier-${k + 1}`), pack, names, bonds: bonds.map(key), predictions };
  });
}
