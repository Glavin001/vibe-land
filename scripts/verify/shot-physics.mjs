// The physics of one shot on the test bed (VIBE_TESTBED_PROBE=1: the run's
// `probe` and `physics`), as numbers: what the acceptance judge
// (acceptance.mjs physicsChecks) and the impact-arm comparison
// (impact-arms.mjs) both read. docs/verification/README.md derives each term.
export const E_REST = 0.1; // WorldConfig restitution
export const ENERGY_TOL = 0.1; // of the impactor's KE: unmeasured fragment rotation, 3-tick sampling

/** null when the run has no probe or no contact. */
export function shotPhysics(r) {
  const pr = r?.probe, ph = r?.physics;
  if (!pr || !ph || !pr.contact) return null;
  // KE at first contact: the window's (the impactor's full speed the tick
  // before it touched), else the probe's vIn (its speed along the shot line,
  // short of the full speed for a descending shot).
  const m = ph.impactorMassKg, ke = ph.window?.contactKeJ ?? 0.5 * m * pr.vIn * pr.vIn, past = r.attack?.pastTarget ?? -1;
  // (1) Pass-through: the straight path's fracture and crush work, plus the
  // KE lost carrying its whole swept mass as a plug (perfectly inelastic).
  const plug = ph.pathMassKg, carry = ke * plug / (m + plug);
  const pathD = ph.pathFractureJ + ph.pathCrushJ + carry;
  // (2) Energy over the structure's own window (first contact to the impactor's
  // exit or its first contact outside it); without one, the whole run less the
  // ground term.
  const w = ph.window;
  const last = pr.energy?.[pr.energy.length - 1] ?? [0, 0, 0, pr.energyLost];
  const [fragKe, pe, lost] = w ? [w.fragmentsKeJ, w.peReleasedJ, w.lostJ] : [last[1], last[2], last[3]];
  const fracture = w ? w.fractureJ : ph.fractureWorkJ, crush = w ? w.crushJ : ph.crushWorkJ;
  const contact = (1 - E_REST * E_REST) * carry; // reduced mass against the plug it set moving
  const ground = w ? 0 : ph.groundJ ?? 0, drop = w ? w.dropJ : ph.impactorDropJ ?? 0;
  const resid = lost + drop + pe - fragKe - fracture - crush - ground;
  return {
    m, ke, past, plug, carry, pathD, mustPass: ke > pathD, passed: ke <= pathD || past >= 1,
    window: w ?? null, lost, drop, pe, fragKe, fracture, crush, contact, ground, resid,
    closes: resid >= -ENERGY_TOL * ke && resid <= contact + ENERGY_TOL * ke,
    afterWindow: ph.afterWindowJ ?? 0,
    momentumLost: pr.momentumLost, peakForceN: pr.peakForceN, heldCapacityN: pr.heldCapacityN, touchedCapacityN: pr.touchedCapacityN,
    infiniteWall: !!pr.infiniteWall, partialHold: !!pr.partialHold,
    brokenIds: ph.brokenIds ?? [], goneIds: ph.goneIds ?? [],
  };
}

/** Jaccard index of two id lists (1 when both are empty). */
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 1 : [...A].filter((x) => B.has(x)).length / union;
}
