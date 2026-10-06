// The chase (films/chase.mjs alone, and in films/trailer.mjs): Vibe Town's
// monster truck (car-10, North Street's west end) floored east through Elm
// Park, weaving as the houses either side are blown apart around it -- and
// then a meteor that catches it anyway, clipping its side and throwing it.
//
// Only the inputs are scripted: the truck's throttle and steering, and each
// meteor's target and the bearing it comes in from. Where the truck goes,
// what the blasts do to it and where it is thrown is the simulation's.
import { hold, track, strike, strikeNear, enter, drive, card, slowmo } from '../film/film.mjs';

/** The driving: full throttle, then weaving (steer -1 left .. 1 right) from 3 s in. */
const WEAVE = [[3.0, 0.45], [3.55, -0.5], [4.1, 0.5], [4.65, -0.45], [5.2, 0.4], [5.75, -0.4], [6.3, 0]];

/**
 * The truck's measured path on that driving and those strikes
 * (films/chase-trace.mjs, FILM_CHECK=1, 2026-10-06; lockstep takes repeat it
 * but for GPU physics): seconds into the chase -> [x, z]. The weave drifts it
 * north, onto the far lane by 7 s.
 * Struck houses are timed from it, and the last meteor aimed at it.
 */
const RUN = [
  [0, -143.8, 46.0], [0.5, -141.9, 46.0], [1, -138.2, 46.0], [1.5, -132.7, 46.0],
  [2, -125.7, 46.0], [2.5, -117.3, 45.9], [3, -107.9, 45.9], [3.5, -97.5, 46.1],
  [4, -86.7, 47.0], [4.5, -75.6, 48.1], [5, -64.1, 49.8], [5.5, -52.0, 51.3],
  [6, -39.8, 52.6], [6.5, -27.2, 53.6], [7, -14.7, 54.5], [7.5, -3.5, 55.8],
  [8, 6.9, 57.1], [8.5, 16.9, 57.4],
];

const lerp = (k, t) => { const [t0, ...a] = RUN[k - 1], [t1, ...b] = RUN[k], f = (t - t0) / (t1 - t0); return a.map((v, i) => v + (b[i] - v) * f); };
/** Where the truck is at t (x, z), from RUN. */
export function truckAt(t) {
  for (let k = 1; k < RUN.length; k += 1) if (t <= RUN[k][0]) return lerp(k, Math.max(t, RUN[0][0]));
  return lerp(RUN.length - 1, t);
}
/** When the truck reaches x (seconds into the chase), from RUN. */
export function truckReaches(x) {
  for (let k = 1; k < RUN.length; k += 1) {
    const [t0, x0] = RUN[k - 1], [t1, x1] = RUN[k];
    if (x <= x1) return t0 + ((x - x0) / (x1 - x0)) * (t1 - t0);
  }
  return Infinity;
}

/**
 * [get-in, the-chase, the-hit]. `title`: a card over the get-in hold (the trailer's
 * "RUN"). `trace`: log the truck's position every 0.1 s. `final: false`
 * leaves out the last meteor -- with trace, the measuring run for RUN.
 */
export function chaseShots(place, { title, trace = false, final = true } = {}) {
  const car = 'car-10';
  const north = place('street/north-street').position[2];
  const getIn = hold({ position: [-160, 6, north + 1], lookAt: [-140, 1.5, north] }, 1.4, {
    name: 'get-in',
    cues: [...(title ? [[0, card(title, 1.4)]] : []), [0, enter(car)], [1.1, drive({ forward: 1, seconds: 0.3 + WEAVE[0][0] })]],
  });
  // Weaving: each steer held until the next (drive() lifts the pedal at its
  // end, and the next one presses it again in the same frame).
  const weave = WEAVE.slice(0, -1).map(([t, steer], k) => [t, drive({ forward: 1, strafe: steer, seconds: WEAVE[k + 1][0] - t })]);
  const coast = [WEAVE.at(-1)[0], drive({ forward: 1, seconds: 4 })];
  // Near misses: North Street's houses, each hit in the wall facing the
  // street, half way up, as the truck comes within 8 m of it -- by a rock
  // that comes in low (slope 0.25: 19 degrees at impact) over the far side's
  // roofs and across the road just ahead of the truck, a few metres over it,
  // and on into the house (north-side houses from the south, 180; south-side
  // from the north, 0), throwing it back off the street. The game's steep
  // meteors landed short, in front gardens and on the road beside the truck,
  // which read as near the truck rather than at the houses (2026-10-06).
  const wall = (house) => [house.position[0], house.top * 0.5, house.side === 'north' ? house.min[2] + 1.5 : house.max[2] - 1.5];
  const houses = place.all
    .filter((p) => p.kind === 'house' && p.street === 'North Street')
    .map((p) => [truckReaches(p.position[0] - 8), p])
    .filter(([t]) => t > 2.6 && t < 6.3);
  const strikes = houses.map(([t, house]) => [t, strike({ at: wall(house), from: house.side === 'north' ? 180 : 0, slope: 0.25 })]);
  // And a car at the street end of a south-side driveway (car-20), the same
  // way: in across the road just ahead of the truck, into the car, the car
  // into its house.
  const parked = place('car-20');
  strikes.push([truckReaches(parked.position[0] - 8), strike({ at: [parked.position[0], 1.0, parked.position[2]], from: 0, slope: 0.25 })]);
  // The last one catches it: square on its right side (south), at body
  // height, coming in flatter than the game's meteors (slope 0.6: ~32 degrees,
  // 84% of its momentum sideways) -- a shove to its left, north, hard into
  // the house. A clip 2.4 m off its side on the ground only lifted it into
  // the wall (2026-10-06). Aimed live, late: launched 0.5 s out at where the
  // truck will be by then (its speed and acceleration). Aimed 2.74 s out from
  // the measured RUN, the weave had carried it 4 m from the mark; 1 s out,
  // a truck slowed by a near miss's debris was only grazed.
  const hit = 6.8;
  const last = !final ? [] : [
    [hit, strikeNear(car, { height: 1.0, from: 180, flight: 0.5, slope: 0.6, flash: true })],
    [hit - 0.2, slowmo(2.2, 0.5)],
  ];
  const traceCues = trace ? Array.from({ length: 90 }, (_, k) => [k * 0.1, (ctx) => {
    const id = ctx.e2e.snapshot()?.drivenVehicleId, v = id != null ? ctx.vehicles.get(id) : null;
    if (v) ctx.log(`truck ${JSON.stringify({ t: +(k * 0.1).toFixed(1), x: +v.position[0].toFixed(2), y: +v.position[1].toFixed(2), z: +v.position[2].toFixed(2), speed: +Math.hypot(v.velocity[0], v.velocity[2]).toFixed(1) })}`);
  }]) : [];
  const chase = track(car, [-13, 4.6, 0.6], hit - 0.55, {
    name: 'the-chase', lookOffset: [9, 1.2, 0], lag: 0.3,
    cues: [...weave, coast, ...strikes, ...last, ...traceCues],
  });
  // The hit, from across the street: a cut to the south side's front
  // gardens, level with where the truck will be hit, looking north at it --
  // the truck crosses the frame, the meteor comes in over the camera, and the
  // truck is driven away from it into the house. Placed from where the truck
  // really is as the shot starts (a track released at once: fixed there,
  // turning to follow it); placed from RUN, a truck slowed by debris was hit
  // 10 m short, out of frame. Looking along the street instead, the near
  // houses hid it (2026-10-06).
  const theHit = track(car, [13, 4.5, -12], 3.2, { name: 'the-hit', lookOffset: [0, 1.5, 3], lag: 0.12, release: 0 });
  return [getIn, chase, theHit];
}
