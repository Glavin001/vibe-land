// Real-world expectations for the scenario matrix (docs/verification/SCENARIOS.md):
// closed forms from impact engineering, independent of the engine and of the
// authored joint strengths. Masses and dimensions come from the scene (they are
// geometry: brick at 1900 kg/m3, a 5 t truck); strengths come from the sources
// cited here, never from the packs.
//
//   node scripts/verify/scenario-physics.mjs      prints the worked examples
//   node --test scripts/verify/scenario-physics.test.mjs

const LB = 0.45359237, IN = 0.0254, FT = 0.3048, PSI = 6894.757;

/**
 * Modified NDRC penetration of a rigid projectile into concrete (Kennedy 1976,
 * "A review of procedures for the analysis and design of concrete structures to
 * resist missile impact effects", Nucl. Eng. Des. 37; the form adopted by
 * UFC 3-340-02 (2008) 4-23ff and DOE-STD-3014 for missiles). US units inside:
 *   G = K N W / d (V / 1000 d)^1.8, K = 180 / sqrt(f'c)   (W lb, d in, V ft/s, f'c psi)
 *   x/d = 2 sqrt(G) (G <= 1), G + 1 (G > 1)
 *   perforation  e/d = 3.19 (x/d) - 0.718 (x/d)^2 (x/d <= 1.35), 1.32 + 1.24 (x/d) (to 13.5)
 *   scabbing     s/d = 7.91 (x/d) - 5.06 (x/d)^2 (x/d <= 0.65), 2.12 + 1.36 (x/d) (to 11.75)
 * N, nose shape: 0.72 flat, 0.84 hemispherical (a sphere), 1.0 blunt, 1.14 sharp.
 * Brick and stone masonry are taken as concrete of the masonry's compressive
 * strength (an extrapolation the matrix states; see SCENARIOS.md "Validity").
 * mass kg, diameter m, speed m/s, fc Pa -> metres.
 */
export const NOSE = { flat: 0.72, sphere: 0.84, blunt: 1.0, sharp: 1.14 };
export function ndrcG(mass, diameter, speed, fc, nose = NOSE.sphere) {
  const W = mass / LB, d = diameter / IN, V = speed / FT, K = 180 / Math.sqrt(fc / PSI);
  return K * nose * (W / d) * Math.pow(V / (1000 * d), 1.8);
}
export const xOverD = (G) => (G <= 1 ? 2 * Math.sqrt(G) : G + 1);
export const perforationOverD = (X) => (X <= 1.35 ? 3.19 * X - 0.718 * X * X : 1.32 + 1.24 * X);
export const scabbingOverD = (X) => (X <= 0.65 ? 7.91 * X - 5.06 * X * X : 2.12 + 1.36 * X);
export function ndrc(mass, diameter, speed, fc, nose = NOSE.sphere) {
  const G = ndrcG(mass, diameter, speed, fc, nose), X = xOverD(G);
  return { G, penetration: X * diameter, perforation: perforationOverD(X) * diameter, scabbing: scabbingOverD(X) * diameter };
}
/** The speed at which the projectile just perforates thickness h (the ballistic limit), by inverting the NDRC chain. */
export function ndrcBallisticLimit(mass, diameter, h, fc, nose = NOSE.sphere) {
  // e/d is increasing in X: bisect X, then G from X, then V from G (G ~ V^1.8).
  let lo = 0, hi = 13.5;
  for (let i = 0; i < 80; i += 1) { const m = (lo + hi) / 2; if (perforationOverD(m) < h / diameter) lo = m; else hi = m; }
  const X = (lo + hi) / 2, G = X <= 2 ? (X / 2) ** 2 : X - 1;
  const G1 = ndrcG(mass, diameter, 1, fc, nose);
  return Math.pow(G / G1, 1 / 1.8);
}

/**
 * Residual speed after perforating a plate with a plug (Recht & Ipson 1963,
 * "Ballistic perforation dynamics", J. Appl. Mech. 30: 384-390): momentum and
 * energy with a perfectly inelastic plug,
 *   v_r = m / (m + m_p) sqrt(v^2 - v_bl^2)   (0 at or below the limit).
 */
export function rechtIpson(m, mPlug, v, vBl) {
  return v <= vBl ? 0 : (m / (m + mPlug)) * Math.sqrt(v * v - vBl * vBl);
}

/**
 * A layered target (brick skin, stud wall, partitions, the far wall) passed in
 * order. Each layer: { name, thickness m, density kg/m3, fc Pa (brittle,
 * NDRC) or work J (members that fail in bending: the energy to break them),
 * plugArea m2 (default the projectile's frontal area) or plugKg }.
 * Returns the speed after each layer and whether it got through all.
 */
export function throughLayers(impactor, layers) {
  const { mass, diameter, speed, frontalArea = Math.PI * diameter * diameter / 4 } = impactor;
  let v = speed, m = mass;
  const out = [];
  for (const L of layers) {
    const plug = L.plugKg ?? (L.plugArea ?? frontalArea) * L.thickness * L.density;
    const vBl = L.fc ? ndrcBallisticLimit(m, diameter, L.thickness, L.fc, impactor.nose) : Math.sqrt(2 * (L.work ?? 0) / m);
    const vr = rechtIpson(m, plug, v, vBl);
    out.push({ layer: L.name, vIn: v, vBl, plugKg: plug, vOut: vr });
    v = vr;
    if (v <= 0) break;
    // A plug carried ahead moves with the impactor: it is part of the mass that
    // meets the next layer (a car pushes its rubble on), unless it is a shot,
    // whose plug flies ahead faster than it (Recht-Ipson: the plug leaves at v_r).
    if (impactor.carries) m += plug;
  }
  return { layers: out, exitSpeed: v, through: v > 0 };
}

/**
 * Vehicle impact on a structure, EN 1991-1-7:2006 Annex C (C.2, C.4): a hard
 * impact with the vehicle deforming, equivalent stiffness k (300 kN/m),
 *   F = v_r sqrt(k m), duration dt = sqrt(m / k).
 * For an impact on a body that itself moves, m is the reduced mass.
 */
export const EN1991_K = 300e3;
export const vehicleImpactForce = (m, v, k = EN1991_K) => ({ force: v * Math.sqrt(k * m), seconds: Math.sqrt(m / k) });
export const reducedMass = (a, b) => (a * b) / (a + b);

/** Timber member in bending (EN 338:2016 C24, mean values: f_m,mean ~ 1.5 f_m,k = 36 MPa, E0,mean 11 GPa;
 * the 1.5 is EN 384's ratio between characteristic and mean for f_m at COV 0.25): the energy a
 * simply supported member of span L, section b x h, absorbs to break under a central load,
 *   P_u = 4 f_m W / L, W = b h^2 / 6; delta = P L^3 / 48 E I; work = P_u delta / 2. */
export function timberBendingWork(b, h, L, fm = 36e6, E = 11e9) {
  const W = (b * h * h) / 6, I = (b * h ** 3) / 12, P = (4 * fm * W) / L;
  return { load: P, work: 0.5 * P * ((P * L ** 3) / (48 * E * I)) };
}

/** A sphere of `mass` kg of density rho: its diameter. */
export const sphereDiameter = (mass, rho) => 2 * Math.cbrt((3 * mass) / (4 * Math.PI * rho));

/** Materials (characteristic or mean, cited), for the expectations. */
export const MATERIAL = {
  // EN 1996-1-1:2005 3.6.1.2 (3.1): f_k = K f_b^0.7 f_m^0.3, group 1 clay units K 0.55,
  // f_b 20 MPa, M10 mortar: 8.9 MPa characteristic; mean ~1.2-1.5x (EN 1052-1 tests): 10-13 MPa.
  brickMasonry: { fc: 10e6, density: 1900, source: 'EN 1996-1-1 eq. 3.1 (K 0.55, f_b 20, f_m 10): f_k 8.9 MPa; mean ~10-13 MPa' },
  // Dressed stone masonry, EN 1996-1-1 Table 3.3 (group 1 natural stone, K 0.45), f_b 40 MPa: f_k ~ 10 MPa; mean ~13.
  stoneMasonry: { fc: 13e6, density: 2400, source: 'EN 1996-1-1 eq. 3.1 (natural stone K 0.45, f_b 40, f_m 10): f_k ~10 MPa; mean ~13 MPa' },
  // C30/37 concrete footing (EN 1992-1-1 Table 3.1).
  concrete: { fc: 38e6, density: 2400, source: 'EN 1992-1-1 Table 3.1, C30/37 f_cm 38 MPa' },
  // 12.5 mm gypsum board, 8.5-10 kg/m2 (EN 520): no compressive strength to speak of; its plug mass only.
  gypsum: { density: 720, source: 'EN 520: 12.5 mm board ~9 kg/m2' },
  c24: { fm: 36e6, E: 11e9, density: 420, source: 'EN 338:2016 C24 (f_m,k 24, mean ~36 MPa; E0,mean 11 GPa; rho_mean 420)' },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const ball = { mass: 10650, diameter: sphereDiameter(10650, 7850), speed: 60 };
  const n = ndrc(ball.mass, ball.diameter, ball.speed, MATERIAL.brickMasonry.fc);
  console.log('cannonball into brick masonry:', n, 'v_bl(0.25 m)', ndrcBallisticLimit(ball.mass, ball.diameter, 0.25, MATERIAL.brickMasonry.fc));
  const b100 = { mass: 100, diameter: sphereDiameter(100, 7850), speed: 60 };
  console.log('100 kg ball:', ndrc(b100.mass, b100.diameter, 60, MATERIAL.brickMasonry.fc), 'v_bl(0.25)', ndrcBallisticLimit(100, b100.diameter, 0.25, MATERIAL.brickMasonry.fc));
  console.log('truck 5 t at 20 m/s (EN 1991-1-7 C):', vehicleImpactForce(5000, 20));
  console.log('C24 38x89 stud, 2.4 m:', timberBendingWork(0.038, 0.089, 2.4));
}
