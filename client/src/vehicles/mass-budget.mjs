/** Mass budgets: a build massed to the real vehicle it stands for.
 *
 * A part's mass is its modelled solid at its material's density
 * (dune/construction.mjs). That is right for a car modelled at full size and
 * full detail. The monster truck is not: it is the sand rail's tube cage and
 * independent suspension, lifted, under a pickup body, on 57 x 22 in tyres,
 * and massed that way it weighed 2794 kg with 217 kg wheels. A Monster Jam
 * truck weighs 4500-5500 kg (reality.mjs `classes.monster`) on 66 x 43 in
 * tyres of 293 kg each, and its weight is in what the model draws as less
 * than it is: more than 800 ft of chassis tubing, solid planetary axles,
 * two-ton running gear.
 *
 * A budget sets the measured totals and leaves the distribution inside each
 * group to the geometry:
 *
 *  - each road wheel (tyre, rim, beadlocks: the `wheel assembly` chunk) at
 *    the real wheel's mass;
 *  - every other part scaled by one factor, so the car weighs `totalKg`.
 *
 * A part massed at k times its modelled material stands for k times the
 * material: k tubes where one is drawn, a k-times-thicker casting. The joints
 * it hangs from carry k times the load, and the real ones have k times the
 * section to do it, so each bond's area scales with the mass it joins
 * (`bondScale`). Stress per joint, the bond stiffness per kilogram it holds,
 * and so the stress solve's behaviour at rest and over bumps, stay what the
 * authored geometry gave; only the momentum the car carries into the world
 * changes. Merging light chunks (chunk-merge.mjs) is decided on the authored
 * mass, before the budget, so the chunk graph is the same one.
 *
 * Driving needs no retune: drivingSetup (customization.mjs) derives the drive
 * torque (mass x acceleration x tyre radius / driven wheels), the brake torque
 * (in proportion to mass), the springs (a corner's weight over 30% of the
 * travel) and the dampers (a ratio of critical) from the car's mass, and the
 * server sizes Vehicle2's tyre stiffness, sprung mass and bump stops per
 * corner load. At 5000 kg every one of them is 1.79x what it was at 2794 kg,
 * so the truck accelerates (7.5 m/s^2), stops (0.85 g) and rides (1.29 Hz,
 * 30% sag) as before; the vehicle test bed's drive trials match to the
 * tenth of a second (structures/vehicle-lab, 2026-10-06).
 *
 * Only builds listed here are budgeted; the others are massed as modelled.
 */
import { classes, ROAD_WHEEL } from './reality.mjs';

const mid = ([lo, hi]) => (lo + hi) / 2;

export const MASS_BUDGET_VERSION = 'mass-budget-1';
export const massBudgets = Object.freeze({
  monster: Object.freeze({
    // The middle of the class (4500-5500 kg): Monster Jam's rule minimum is
    // 10,000 lb (4536 kg) and a competition truck 12,000 lb (5443 kg,
    // Monster Jam World Finals "by the numbers", 2024).
    totalKg: mid(classes.monster.massKg),
    // "645 pounds: combined tire and wheel weight" of the 66 x 43 in BKT
    // tyre on its beadlock wheel (same source): 292.6 kg.
    wheelKg: 645 * 0.45359237,
  }),
});

/** VIBE_VEHICLE_MASS_BUDGET=0 (asset worker): every build massed as modelled, for A/B. */
export function massBudget(model) {
  if (globalThis.process?.env?.VIBE_VEHICLE_MASS_BUDGET === '0') return null;
  return massBudgets[model] ?? null;
}

/**
 * Per-part mass factors that put `parts` on `budget`. `massOf(part)` is a
 * part's authored mass. Returns Map(part id -> factor).
 */
export function budgetScales(parts, massOf, budget) {
  const wheels = parts.filter(p => ROAD_WHEEL.test(p.name));
  if (wheels.length !== 4) throw new Error(`Mass budget expects four road wheels, found ${wheels.length}`);
  const rest = parts.filter(p => !ROAD_WHEEL.test(p.name));
  const restKg = rest.reduce((n, p) => n + massOf(p), 0);
  const restTarget = budget.totalKg - wheels.length * budget.wheelKg;
  if (!(restKg > 0 && restTarget > 0)) throw new Error('Mass budget leaves nothing for the rest of the car');
  const scales = new Map(rest.map(p => [p.id, restTarget / restKg]));
  for (const w of wheels) scales.set(w.id, budget.wheelKg / massOf(w));
  return scales;
}

/** A bond's area factor: the mass it joins, budgeted over authored. */
export function bondScale(bond, massOf, scaleOf) {
  const a = massOf(bond.a), b = massOf(bond.b);
  return (a * scaleOf(bond.a) + b * scaleOf(bond.b)) / (a + b);
}
