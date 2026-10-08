/**
 * Scenario 6b (docs/calibration/house-headers.md "Sequencing (C10)"): the
 * bungalow's front-wall bays knocked out by removal, the set-up of the C10
 * study (structures/town-kit/scripts/sequence-lab.py, removal) and of the
 * alternate path method (GSA 2016, UFC 4-023-03): the house first stands at
 * equilibrium with the case's members in place, then they are gone in one
 * tick. house-headers builds each case with its gap (as built), whose first
 * tick has no equilibrium to start from.
 *
 * The removed members (house-headers' knockOut: the bay's frame and skin) are
 * static PhysX boxes the house stands on, at each member's box, removed at
 * FIRE_TICK (server/src/calibration_charges.rs, as the demolition's cutting
 * charges): the structure above loses that support in one tick and the stage
 * sees it through the contact loads that stop. A box is the member's bounds
 * less SIDE_GAP on each horizontal face, so it does not overlap the members
 * beside it and bears only through its top and bottom.
 *
 * Cases and predictions are house-headers' (the hand calculation of the plate
 * over the gap).
 */
import * as base from './house-headers.mjs';
import { aabb } from '../src/house.mjs';
import { buildVeneerHouse } from '../../town-kit/src/veneer-houses.mjs';

export const id = 'house-headers-removal';
export const title = 'Calibration: brick-veneer bungalow (revision 2), front-wall bays removed from the standing house';
// 2 s standing on its supports (the stage's warm-started 64-iteration solve settles the
// five houses), then 8 s after the removal: the CPU reference's sequences end by 2.5 s
// but for contacts sliding off their seats at friction (truck: to 7.7 s).
export const FIRE_TICK = 120;
export const ticks = 600;
export const spacing = base.spacing;
export const iterations = base.iterations;
export const band = base.band;
export const tolerate = base.tolerate;
export const models = base.models;
export const configModel = base.configModel;
export const hand = base.hand;
const SIDE_GAP = 0.002;   // m: a box clear of its neighbours' faces (the chunks' hulls touch them)
const KNOCKED = new Set(['stud', 'king-stud', 'jack-stud', 'cripple-stud', 'brick-veneer', 'veneer-lintel-course', 'drywall', 'glazing', 'window-frame', 'door-frame']);

/** The members house-headers' knockOut removes over the bay, as boxes [lo, hi]. */
function supports(pack, bay) {
  if (!bay) return [];
  const s = pack.scenario, out = [];
  for (let i = 0; i < s.nodes.length; i++) {
    const [lo, hi] = aabb(s, i), c = (lo[0] + hi[0]) / 2;
    if (!(hi[2] < -3.5 && KNOCKED.has(s.nodeTypes[i]) && c >= bay[0] && c <= bay[1])) continue;
    out.push([[lo[0] + SIDE_GAP, lo[1], lo[2] + SIDE_GAP], [hi[0] - SIDE_GAP, hi[1], hi[2] - SIDE_GAP]]);
  }
  return out;
}

export function cases() {
  const built = base.cases();
  const { pack } = buildVeneerHouse({ storeys: 1, revision: 2 });
  return base.CASES.map((c, k) => {
    const boxes = supports(pack, c.bay), b = built[k];
    // The intact case keeps nothing to fire; the others fire their supports at FIRE_TICK.
    return { ...b, label: `${b.label} (removed at tick ${FIRE_TICK})`, charges: boxes.length ? [{ tick: FIRE_TICK, boxes }] : [] };
  });
}
