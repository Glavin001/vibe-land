/**
 * Tyres in series with the suspension (VIBE_VEHICLE_TYRE_BOUND=1, opt-in;
 * docs/destruction/IMPACT_STEP_PLAN.md section 8, "wheel loss").
 *
 * Vehicle2 has no tyre between the road and the wheel: a wheel whose road
 * jumps within a step (a wall's stump, a kerb face) sees its whole jounce
 * change as damper speed, and its travel limit as a rigid stop. In the vehicle
 * lab the monster truck's front wheel took a 582 kN suspension force on the
 * 10.9 m/s wall's stump and lost its hub. But the road reaches the wheel only
 * through the tyre, and a pneumatic tyre's force is its inflation pressure
 * over its contact patch (Gent & Walter, The Pneumatic Tire, NHTSA 2006,
 * ch. 7), A = b 2 sqrt(2 R d) for a deflection d, largest when the tyre is
 * flat on its rim, d = the section height: F_max = p b 2 sqrt(2 R sec). Past it
 * the rim bears: a contact of the wheel's own with what it meets, not the
 * suspension's. So with the bound:
 * - the asset carries each road wheel's tyre and F_max (metadata `tyre`); the
 *   server sets Vehicle2's NativeVehicleDesc::tyreMaxForce from it, bounding
 *   each wheel's suspension force (spring and damper) and its suspension-limit
 *   rows (PhysX PX_NATIVE_VEHICLE_TYRE_MAX_FORCE_VERSION);
 * - each road wheel gets a rim hull (`rim: true`): the rim's cylinder inside
 *   the tyre, which unlike the tyre's own hull (excluded from everything the
 *   road query stands on) meets the world, so a wheel pushed past its tyre
 *   bears on its rim as an ordinary contact (compliant steel in an impact
 *   window).
 * The two are one model and go together: the bound alone would let a wheel
 * sink through what it meets.
 */
import { ROAD_WHEEL } from './reality.mjs';

export const tyreBoundEnabled = () => (globalThis.process?.env?.VIBE_VEHICLE_TYRE_BOUND ?? '0') === '1';
export const TYRE_BOUND_VERSION = 'tyre-bound-1';

/**
 * Inflation and rim of each build's tyres (builds not listed get no bound).
 * - monster: 66 x 43.00-25 flotation tyres at about 1.6 bar (23 psi: Monster
 *   Jam, "Truck Body Facts", 2023; BKT, "Behind the scenes of BKT tires for
 *   Monster Jam", 2024). The asset's wheel is smaller than 66 in, so its rim is
 *   the size's proportion, 25 / 66 of the outside diameter.
 */
export const TYRES = Object.freeze({
  monster: Object.freeze({ pressurePa: 1.6e5, rimToOutside: 25 / 66 }),
});

const RIM_SEGMENTS = 16;

/** A road wheel's tyre from its hulls (actor frame, axle along x): outside radius R, tread width b, section height, F_max. */
export function tyreOf(part, spec) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const shape of part.shapes) for (const v of shape.vertices) for (let k = 0; k < 3; k += 1) {
    const x = part.position[k] + shape.position[k] + v[k];
    lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x);
  }
  const radius = 0.5 * Math.max(hi[1] - lo[1], hi[2] - lo[2]), width = hi[0] - lo[0];
  const section = radius * (1 - spec.rimToOutside);
  const maxForceN = spec.pressurePa * width * 2 * Math.sqrt(2 * radius * section);
  const center = lo.map((l, k) => (l + hi[k]) / 2);
  return { pressurePa: spec.pressurePa, rimToOutside: spec.rimToOutside, radiusM: radius, widthM: width, sectionM: section, maxForceN, center };
}

/** The rim's hull: a cylinder of radius R rimToOutside across the tread width, about the tyre's centre (part frame). */
export function rimShape(part, tyre) {
  const r = tyre.radiusM * tyre.rimToOutside, half = tyre.widthM / 2;
  const c = tyre.center.map((x, k) => x - part.position[k]);
  const vertices = [];
  for (const side of [-half, half]) for (let i = 0; i < RIM_SEGMENTS; i += 1) {
    const a = i * 2 * Math.PI / RIM_SEGMENTS;
    vertices.push([side, r * Math.cos(a), r * Math.sin(a)]);
  }
  return { type: 'rim', rim: true, position: c, vertices };
}

/**
 * Put each road wheel of a build listed in TYRES on its tyre: a rim hull on
 * the wheel and the tyre's bound for the asset's metadata. Returns the
 * metadata entry, or null for a build with no tyre spec.
 */
export function applyTyreBound(model, parts) {
  const spec = TYRES[model];
  if (!spec) return null;
  const wheels = parts.filter((p) => ROAD_WHEEL.test(p.name));
  if (wheels.length !== 4) throw new Error(`The tyre bound expects four road wheels, found ${wheels.length}`);
  const tyres = wheels.map((w) => tyreOf(w, spec));
  for (let i = 0; i < wheels.length; i += 1) wheels[i].shapes.push(rimShape(wheels[i], tyres[i]));
  // One bound for the vehicle (Vehicle2's desc): the least of its wheels'.
  const least = tyres.reduce((a, b) => (b.maxForceN < a.maxForceN ? b : a));
  const { center, ...tyre } = least;
  return { version: TYRE_BOUND_VERSION, ...tyre };
}
