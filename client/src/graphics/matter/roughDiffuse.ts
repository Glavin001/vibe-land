// Energy-preserving rough diffuse (EON), our implementation.
//
// Model: Portsmouth, Kutz and Hill, "EON: A practical energy-preserving rough
// diffuse BRDF", JCGT 14(1), 2025 (https://jcgt.org/published/0014/01/06/).
// Single scattering is the Fujii form of Oren-Nayar (FON); multiple scattering
// is the energy-compensation lobe that restores what FON loses, so a white
// surface reflects exactly what it receives at every roughness.
//
//   f_FON(i,o) = rho/pi * A * (1 + sigma * s/t)
//     s = i.o - mu_i mu_o,  t = max(mu_i, mu_o) if s > 0 else 1
//     A = 1 / (1 + (1/2 - 2/(3 pi)) sigma)
//   E_FON(mu)  = A * (1 + sigma * G(mu))       (directional albedo, rho = 1)
//   Ebar       = A * (1 + sigma * (2/3 - 28/(15 pi)))   (its cosine-weighted mean)
//   f_ms(i,o)  = rho_ms/pi * (1 - E_FON(mu_i)) (1 - E_FON(mu_o)) / (1 - Ebar)
//     rho_ms   = rho^2 Ebar / (1 - rho (1 - Ebar))
//
// G is the exact hemispherical integral of s/t (derived here, not fitted):
//   G(theta) = (2/pi) sin(theta) * [ theta/2 - sin(theta)cos(theta)/2 - sin^3(theta)/3
//                                    + (1/cos(theta) - 1)(1 - sin^3(theta))/3 ]
// so the albedo is exact rather than a polynomial fit, and the view-side term
// is evaluated once per pixel and shared by every light.
//
// The TSL builders are for the WebGPU path; roughDiffuseMath.ts is the same
// equations as plain numbers for the unit tests (reciprocity, the Lambert
// limit, the white furnace).

import { Fn, PI, acos, float, max, min, select, sqrt } from 'three/tsl';

import { MEAN_G, MU_FLOOR, SINGLE_A } from './roughDiffuseMath';

// TSL nodes are loosely typed in @types/three 0.170.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

/** fonAlbedo as a node: (mu, sigma) -> float. */
export const fonAlbedoNode: Node = Fn(([mu, sigma]: [Node, Node]) => {
  const c = min(max(mu, MU_FLOOR), 1);
  const theta = acos(c);
  const sn = sqrt(max(c.mul(c).oneMinus(), 0));
  const s3 = sn.mul(sn).mul(sn);
  const inner = theta
    .mul(0.5)
    .sub(sn.mul(c).mul(0.5))
    .sub(s3.div(3))
    .add(float(1).div(c).sub(1).mul(s3.oneMinus()).div(3));
  const g = sn.mul(inner).mul(2 / Math.PI);
  return float(1).div(sigma.mul(SINGLE_A).add(1)).mul(sigma.mul(g).add(1));
});

/**
 * The view-side pieces, once per pixel: A, the mean albedo, the
 * multiple-scattering albedo and (1 - E_FON(mu_o)) / (1 - Ebar).
 */
export function eonViewTerms(rho: Node, sigma: Node, muO: Node) {
  const a = float(1).div(sigma.mul(SINGLE_A).add(1)).toVar('eonA');
  const mean = a.mul(sigma.mul(MEAN_G).add(1)).toVar('eonMean');
  const rhoMs = rho.mul(rho).mul(mean).div(rho.mul(mean.oneMinus()).oneMinus()).toVar('eonRhoMs');
  const eo = fonAlbedoNode(muO, sigma).toVar('eonEo');
  const viewMs = eo.oneMinus().div(max(mean.oneMinus(), 1e-7)).toVar('eonViewMs');
  return { a, mean, rhoMs, eo, viewMs };
}

export type EonViewTerms = ReturnType<typeof eonViewTerms>;

/** EON BRDF value (no cosine) for one light, given the per-pixel view terms. */
export function eonDirect(
  rho: Node,
  sigma: Node,
  wi: Node,
  wo: Node,
  n: Node,
  muO: Node,
  view: EonViewTerms,
): Node {
  const muI = max(n.dot(wi), MU_FLOOR);
  const s = wi.dot(wo).sub(muI.mul(muO));
  const sOverT = select(s.greaterThan(0), s.div(max(muI, muO)), s);
  const single = rho.mul(view.a).mul(sigma.mul(sOverT).add(1)).div(PI);
  const multi = view.rhoMs.div(PI).mul(fonAlbedoNode(muI, sigma).oneMinus()).mul(view.viewMs);
  return single.add(multi);
}

/**
 * EON's directional albedo over Lambert's (rho): the factor that turns
 * Lambert indirect diffuse into EON's for a uniform environment.
 */
export function eonIndirectScale(rho: Node, view: EonViewTerms): Node {
  const albedo = rho.mul(view.eo).add(view.rhoMs.mul(view.eo.oneMinus()));
  return albedo.div(max(rho, 1e-4));
}
