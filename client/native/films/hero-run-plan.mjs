// The hero film's plan (client/native/films/hero-run.mjs): its zones in
// order along Main Street (x east, metres), each zone's length in film
// seconds, its route speed, and where a zone run parks the truck to reach it
// (scripts/film/hero-run.sh). Pure, no game: node imports it too.
//
// Main Street in Vibe Town's hero variant (structures/vibe-town/build-town.mjs):
// the approach and launch ramp west of x -150 (the ramp x -206..-195, 3 m), Elm
// Park's houses to Main Avenue at 0 (West Avenue crossing at -80, the corner
// cafe at -31.5..-19.5 north), the Market Quarter's shops north and bus
// station south from 8, East Avenue at 70, the towers south from 84.

/** The truck's parking spot, facing east on the approach (the scene's car-0). */
export const HERO_START = [-262, 0, 90];
/** How far either side of the centre line the planner may take it: the asphalt's 4 m less the truck's half width... */
export const ROAD_HALF = 2.4;
/** ...and, when the road is blocked, onto the pavement (6 m less the half width), at a cost. */
export const KERB_HALF = 4.4;

/**
 * Each zone: `seconds` of film; `toX` where the next begins (its speed holds
 * until then); `speed` (m/s) on that stretch; `entry` where the truck is when
 * the zone begins in the whole film (the estimate a zone run aims for);
 * `runup` where a zone run parks the truck and `runupSeconds` before its
 * first shot. `trimAt`: where the cut starts within the first zone.
 */
export const ZONES = [
  { name: 'launch', seconds: 8.4, trimAt: 3.2, toX: -150, speed: 18, entry: -262, runup: HERO_START, runupSeconds: 0 },
  { name: 'driveway', seconds: 4.2, toX: -100, speed: 13, entry: -152, runup: [-188, 0, 90], runupSeconds: 3.6 },
  { name: 'cockpit', seconds: 4.4, toX: -48, speed: 11.5, entry: -100, runup: [-136, 0, 90], runupSeconds: 3.6 },
  { name: 'cafe', seconds: 4.4, toX: -6, speed: 12, entry: -50, runup: [-86, 0, 90], runupSeconds: 3.6 },
  { name: 'gauntlet', seconds: 5.8, toX: 66, speed: 12, entry: -6, runup: [-42, 0, 90], runupSeconds: 3.6 },
  { name: 'tower', seconds: 10, toX: 400, speed: 10, entry: 66, runup: [30, 0, 90], runupSeconds: 3.6, stopX: 84 },
];

export const zoneOf = (name) => {
  const z = ZONES.find((zone) => zone.name === name);
  if (!z) throw new Error(`hero-run: no zone ${name} (${ZONES.map((zone) => zone.name).join(', ')})`);
  return z;
};

/** The scene's slots with the truck's (slot 0) moved to a zone's run-up: VIBE_CITY_FLEET_SLOTS. */
export function zoneSlots(slots, name) {
  const [x, z, heading] = zoneOf(name).runup;
  const list = slots.split(';');
  list[0] = `${x},${z},${heading}`;
  return list.join(';');
}
