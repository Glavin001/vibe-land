/**
 * Scenario 6b (docs/calibration/house-headers.md "Sequencing (C10)"): the
 * bungalow's front-wall bays knocked out by removal, the set-up of the C10
 * study (structures/town-kit/scripts/sequence-lab.py, removal) and of the
 * alternate path method (GSA 2016, UFC 4-023-03): the house first stands
 * intact at equilibrium, then the case's members are gone in one tick.
 * house-headers builds each case with its gap (as built), whose first tick has
 * no equilibrium to start from.
 *
 * The removal: at FIRE_TICK the stage cuts every bond of the members
 * house-headers' knockOut takes out (the bay's frame and skin; PhysX
 * PX_DESTRUCTION_REMOVE_BONDS, written by scenario.mjs from each case's
 * `removals`). The members fall out as free bodies. (Static support boxes, as
 * the demolition's charges, cannot stand in for them: the bungalow is anchored,
 * and a kinematic cluster makes no contact with a static box.)
 *
 * Predictions are house-headers' (the hand calculation of the plate over the gap).
 */
import * as base from './house-headers.mjs';
import { aabb } from '../src/house.mjs';
import { buildVeneerHouse } from '../../town-kit/src/veneer-houses.mjs';

export const id = 'house-headers-removal';
export const title = 'Calibration: brick-veneer bungalow (revision 2), front-wall bays removed from the standing house';
// 2 s standing intact (the stage's warm-started 64-iteration solve settles the five
// houses), then 8 s after the removal: the CPU reference's sequences end within 4 s
// but for contacts sliding off their seats at friction.
export const FIRE_TICK = 120;
export const ticks = 600;
export const spacing = base.spacing;
export const iterations = base.iterations;
export const band = base.band;
export const tolerate = base.tolerate;
export const models = base.models;
export const configModel = base.configModel;
export const hand = base.hand;
const KNOCKED = new Set(['stud', 'king-stud', 'jack-stud', 'cripple-stud', 'brick-veneer', 'veneer-lintel-course', 'drywall', 'glazing', 'window-frame', 'door-frame']);

/** The nodes house-headers' knockOut removes over the bay. */
function removedNodes(pack, bay) {
  if (!bay) return new Set();
  const s = pack.scenario, out = new Set();
  for (let i = 0; i < s.nodes.length; i++) {
    const [lo, hi] = aabb(s, i), c = (lo[0] + hi[0]) / 2;
    if (hi[2] < -3.5 && KNOCKED.has(s.nodeTypes[i]) && c >= bay[0] && c <= bay[1]) out.add(i);
  }
  return out;
}

export function cases() {
  const built = base.cases();
  const { pack, metadata } = buildVeneerHouse({ storeys: 1, revision: 2 });
  const bonds = base.keys(pack, metadata.nodeWalls);
  const names = pack.scenario.nodeTypes.map((t, i) => `${t}${metadata.nodeWalls[i] ? `/${metadata.nodeWalls[i]}` : ''}#${i}`);
  return base.CASES.map((c, k) => {
    const gone = removedNodes(pack, c.bay), b = built[k];
    const cut = pack.scenario.bonds.map((x, i) => (gone.has(x.node0) || gone.has(x.node1) ? i : -1)).filter((i) => i >= 0);
    return { ...b, pack, names, bonds, label: `${b.label} (removed at tick ${FIRE_TICK})`, removals: cut.length ? [{ tick: FIRE_TICK, bonds: cut }] : [],
      notes: `${gone.size} members, ${cut.length} bonds cut at tick ${FIRE_TICK}` };
  });
}
