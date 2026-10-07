/**
 * Calibration materials and member capacities, every number from the code or
 * test data cited beside it. Timber, connections, gypsum and mortar are the
 * town kit's (structures/town-kit/src/materials.mjs, imported, not copied);
 * this adds what the calibration structures need beyond a house: reinforced
 * concrete (EN 1992-1-1), structural steel (EN 1993-1-1) and glulam (EN 14080).
 *
 * How a capacity becomes an engine material. The native stage checks each
 * bond's fibre stresses -- normal N/A, bending M/S (S the bond patch's elastic
 * section modulus with VIBE_SECTION_BENDING; a capped square-patch gain
 * without), shear V/A -- against a material's elastic and fatal limits:
 * damage accrues above `elastic` at a rate, a bond breaks at once above
 * `fatal` (PhysX NvBlastExtStressMaterialFormula.h extStressBondDamage). So a
 * member capacity R becomes the stress the engine's own formula reaches at R:
 *   flexure   tension = M_R / S_el   (the bond breaks when the section reaches M_R)
 *   squash    compression = N_R / A
 *   shear     shear = V_R / A
 * `elastic` is what the member carries indefinitely: equal to `fatal` where
 * the material does not lose strength under sustained load (steel; reinforced
 * concrete in flexure, governed by its steel; brittle shear), and 0.85 of it
 * for concrete in compression (Ruesch's sustained-load strength, the
 * EN 1992-1-1 3.1.6(1) alpha_cc for long-term effects). Timber keeps the town
 * kit's k_mod 0.6 (EN 1995-1-1 Table 3.1, permanent actions).
 *
 * Strengths are characteristic (5% fractile), as in materials.mjs. A real
 * structure's mean strength is higher (reinforcement f_ym ~ 1.1-1.15 f_yk,
 * JCSS Probabilistic Model Code 3.2); the predictions carry that as their
 * upper uncertainty bound.
 */
export { C24, LONG_TERM, CONNECTIONS, NAIL, SLIP, BEARING, GYPSUM, MORTAR_JOINT } from '../../town-kit/src/materials.mjs';
import { CRUSH, crushEnabled } from '../../town-kit/src/materials.mjs';

const G = 9.81;

/** EN 1992-1-1 Table 3.1 (MPa -> Pa). */
export const CONCRETE = {
  C30: { fck: 30e6, fctm: 2.9e6, Ecm: 33e9 },
  C35: { fck: 35e6, fctm: 3.2e6, Ecm: 34e9 },
  C40: { fck: 40e6, fctm: 3.5e6, Ecm: 35e9 },
};
/** Reinforced concrete, 25 kN/m^3 (EN 1991-1-1 Table A.1, normal-weight concrete with normal reinforcement). */
export const RC_DENSITY = 25e3 / G;
/** Reinforcing steel B500B: f_yk 500 MPa (EN 1992-1-1 Annex C), E_s 200 GPa (3.2.7(4)). */
export const REBAR = { fyk: 500e6, Es: 200e9 };
/** Structural steel S355 (t <= 40 mm): f_y 355 MPa, f_u 490 MPa (EN 1993-1-1 Table 3.1), E 210 GPa, 7850 kg/m^3 (3.2.6). */
export const S355 = { fy: 355e6, fu: 490e6, E: 210e9, G: 81e9, density: 7850 };
/**
 * Glued laminated timber GL28h (EN 14080:2013 Table 5): f_m,g,k 28 MPa,
 * f_c,0,g,k 28 MPa, f_t,0,g,k 22.3 MPa, f_v,g,k 3.5 MPa, E_0,g,mean 12.6 GPa,
 * rho_g,k 425 kg/m^3 (mean ~460).
 */
export const GL28H = { fm: 28e6, fc0: 28e6, ft0: 22.3e6, fv: 3.5e6, E: 12.6e9, density: 460 };

/** A pack material entry (the ScenePack v2 table's fields). */
export function packMaterial(name, { density, E, compression, tension, shear, sustained = {}, color = '#b9b5ad', textureKey = 'white-concrete', roughness = 0.85, metalness = 0 }) {
  const k = (key) => sustained[key] ?? 1;
  return {
    name, color, textureKey, roughness, metalness, density, elasticModulus: E, residualAreaFraction: 0,
    compressionElastic: k('compression') * compression, compressionFatal: compression,
    tensionElastic: k('tension') * tension, tensionFatal: tension,
    shearElastic: k('shear') * shear, shearFatal: shear,
  };
}

/**
 * A rectangular reinforced-concrete section b x h (bending about the axis
 * along b), equal reinforcement As each face at `cover` to the bars' centre.
 * Characteristic capacities (gamma = 1), EN 1992-1-1:
 *   M_Rk  rectangular stress block (3.1.7(3): lambda 0.8, eta 1), compression bars neglected
 *   M_yk  first yield of the tension bars, cracked elastic section, n = E_s / E_cm
 *   V_Rk  6.2.2(1) without shear reinforcement, C_Rk,c = 0.18 (0.12 x gamma_c 1.5), v_min floor;
 *         with `links` {Asw, s} the larger of that and 6.2.3(3) V_Rk,s (cot theta 2.5)
 *   N_Rk  squash load f_ck A_c + A_s,tot f_yk (alpha_cc 1)
 */
export function rcRect({ b, h, cover, As, concrete = CONCRETE.C35, fyk = REBAR.fyk, links = null }) {
  const { fck, Ecm } = concrete, A = b * h, S = b * h * h / 6, I = b * h ** 3 / 12, d = h - cover;
  const x = As * fyk / (0.8 * fck * b);
  const M_Rk = As * fyk * (d - 0.4 * x);
  const n = REBAR.Es / Ecm, rho = As / (b * d), k = Math.sqrt(2 * rho * n + (rho * n) ** 2) - rho * n;
  const M_yk = As * fyk * (d - k * d / 3);
  const ks = Math.min(2, 1 + Math.sqrt(0.2 / d)), rhoL = Math.min(0.02, rho);
  const vRk = Math.max(0.18 * ks * Math.cbrt(100 * rhoL * fck / 1e6), 0.035 * ks ** 1.5 * Math.sqrt(fck / 1e6)) * 1e6;
  // With links (EN 1992-1-1 6.2.3(3), cot theta 2.5): V_Rk,s = A_sw / s z f_ywk cot theta, z = 0.9 d.
  const V_Rk = Math.max(vRk * b * d, links ? links.Asw / links.s * 0.9 * d * fyk * 2.5 : 0);
  const N_Rk = fck * (A - 2 * As) + 2 * As * fyk;
  return { b, h, A, S, I, d, As, rho, xOverD: x / d, M_Rk, M_yk, V_Rk, N_Rk, E: Ecm };
}

/** The engine material for a reinforced-concrete member of section `sec` (rcRect). */
export function rcMaterial(name, sec, opts = {}) {
  const m = packMaterial(name, {
    density: RC_DENSITY, E: sec.E,
    tension: sec.M_Rk / sec.S, compression: sec.N_Rk / sec.A, shear: sec.V_Rk / sec.A,
    sustained: { compression: 0.85 }, ...opts,
  });
  // Chunk crushing, opt-in (VIBE_CRUSH=1, the high profile): the town kit's cited C30/37 crush block
  // (materials.mjs CRUSH.concrete) -- what lets a jammed concrete block crush at its hinge edges.
  if (crushEnabled()) m.crush = structuredClone(CRUSH.concrete);
  return m;
}

/**
 * Minimum flexural reinforcement, EN 1992-1-1 9.2.1.1(1): 0.26 f_ctm / f_yk b d,
 * not less than 0.0013 b d.
 */
export const asMin = (b, d, concrete = CONCRETE.C35, fyk = REBAR.fyk) => Math.max(0.26 * concrete.fctm / fyk, 0.0013) * b * d;

/**
 * Design (ULS) area of tension steel for M_Ed on a b x d section: gamma_c 1.5,
 * gamma_s 1.15, alpha_cc 1 (EN 1992-1-1 2.4.2.4, 3.1.6), stress block; at
 * least As,min.
 */
export function designAs(M_Ed, b, d, concrete = CONCRETE.C35, fyk = REBAR.fyk) {
  const fcd = concrete.fck / 1.5, fyd = fyk / 1.15;
  const K = M_Ed / (b * d * d * fcd);
  if (K > 0.167) throw Error(`section too shallow for ${(M_Ed / 1e3).toFixed(0)} kN m (K ${K.toFixed(3)} > 0.167): needs compression steel`);
  const z = Math.min(0.95 * d, d * (0.5 + Math.sqrt(0.25 - K / 1.134)));
  return Math.max(M_Ed / (fyd * z), asMin(b, d, concrete, fyk));
}
