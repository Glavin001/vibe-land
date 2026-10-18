// The chase (films/chase.mjs alone, and in films/trailer.mjs): Vibe Town's
// monster truck (car-10, North Street's west end) floored east through Elm
// Park, weaving as the houses either side are blown apart around it -- and
// then a meteor that catches it anyway, clipping its side and throwing it.
//
// Only the inputs are scripted: the truck's throttle and steering, and each
// meteor's target and the bearing it comes in from. Where the truck goes,
// what the blasts do to it and where it is thrown is the simulation's.
import { hold, track, watch, strike, strikeNear, enter, drive, card } from '../film/film.mjs';
import { assertStrikesClear, METEOR_FLIGHT_S } from '../film/shots.mjs';

/**
 * The driving: full throttle, then weaving from 3 s in (steer +1 turns it
 * north, toward the north-side houses, about half a second after the
 * input), then from 5.2 s steered (10 times a second, from where it is) to
 * HOUSE_LINE_Z, a few metres off the north houses, where the last meteor
 * catches it and drives it into one. Hit out in the south lane, it was
 * wrecked where it stood, 12 m short of any house; an open-loop drift north
 * left it anywhere from 2.6 to 8 m short across takes (2026-10-06).
 */
const WEAVE = [[3.0, 0.45], [3.55, -0.5], [4.1, 0.5], [4.65, -0.45], [5.2, 0]];
/** Where the last stretch steers it (z, a few metres off the north houses' fronts at ~58.3). */
const HOUSE_LINE_Z = 55;

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
 * [get-in, the-chase, ahead-of-it, the-hit]. `title`: a card over the get-in hold (the trailer's
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
  const truck = (ctx) => { const id = ctx.e2e.snapshot()?.drivenVehicleId; return id != null ? ctx.vehicles.get(id) : null; };
  const state = { hitAt: null };
  // To the house line: steer by how far off it the truck is and how fast it
  // is closing (its response lags the wheel by ~0.5 s), until the hit.
  const steering = [WEAVE.at(-1)[0], {
    label: `steer to z ${HOUSE_LINE_Z}`,
    steps: Array.from({ length: 30 }, (_, k) => [k * 0.1, (ctx) => {
      const v = truck(ctx);
      if (!v || state.hitAt != null) { ctx.drive.move({ forward: 1 }); return; }
      // Gain 0.12 reached only 53.2 by the hit; 0.25 gets there by ~6.3 s.
      const steer = Math.max(-0.7, Math.min(0.7, 0.25 * (HOUSE_LINE_Z - v.position[2]) - 0.35 * v.velocity[2]));
      ctx.drive.move({ forward: 1, strafe: steer });
    }]),
  }];
  // Near misses: North Street's houses, each hit in the wall facing the
  // street, half way up, as the truck is 10 m past it -- by
  // a rock that comes in low (slope 0.25: 19 degrees at impact) over the far
  // side's roofs and across the road between the truck and the chase camera,
  // and on into the house (north-side houses from the south, 180; south-side
  // from the north, 0), throwing it back off the street (2026-10-06):
  // - the game's steep meteors landed short, in front gardens and on the
  //   road beside the truck: near the truck, not at the houses;
  // - crossing just AHEAD of the truck, the house came back onto the road in
  //   front of it, and in a full take it stalled there twice;
  // - 4 m behind it, the rock and the blast caught its back end, and it lost
  //   its wheels (scripts/vehicle-testbed.sh measures what it should take).
  // North-side houses 3 m east of their middle, south-side 3 m west: the
  // houses face each other in pairs, struck at the same moment from opposite
  // sides, and aimed at the middles the two rocks passed 1.6 m apart over
  // the road -- closer than two radii, so they met there instead.
  const wall = (house) => [house.position[0] + (house.side === 'north' ? 3 : -3), house.top * 0.5, house.side === 'north' ? house.min[2] + 1.5 : house.max[2] - 1.5];
  const houses = place.all
    .filter((p) => p.kind === 'house' && p.street === 'North Street')
    .map((p) => [truckReaches(p.position[0] + 10), p])
    .filter(([t]) => t > 2.6 && t < 6.3);
  const strikes = houses.map(([t, house]) => [t, strike({ at: wall(house), from: house.side === 'north' ? 180 : 0, slope: 0.25 })]);
  // Each lands at its time (strike(): launched METEOR_FLIGHT_S before).
  assertStrikesClear(houses.map(([t, house]) => ({ at: t - METEOR_FLIGHT_S, target: wall(house), from: house.side === 'north' ? 180 : 0, flight: METEOR_FLIGHT_S, slope: 0.25 })), 'the chase');
  // And a car at the street end of a south-side driveway (car-20), the same
  // way: in across the road behind the truck, into the car, the car
  // into its house.
  const parked = place('car-20');
  strikes.push([truckReaches(parked.position[0] + 10), strike({ at: [parked.position[0], 1.0, parked.position[2]], from: 0, slope: 0.25 })]);
  // The last one catches it: square on its right side (south), at body
  // height, coming in flat (slope 0.35: ~20 degrees, 94% of its momentum
  // sideways; the drift north leaves 18 m to clear the far side's roofs) --
  // a shove to its left, north, hard into the house. At slope 0.6 it lifted
  // the truck up the house's front more than through it. A clip 2.4 m off its side on the ground only lifted it into
  // the wall (2026-10-06). Aimed live, late: launched 0.5 s out at where the
  // truck will be by then (its speed and acceleration). Aimed 2.74 s out from
  // the measured RUN, the weave had carried it 4 m from the mark; 1 s out,
  // a truck slowed by a near miss's debris was only grazed.
  // Fired when the truck reaches FIRE_X along the street (6.9 s at the
  // latest), so that 0.5 s later it is beside the house at x -17 -- in front
  // of the hit camera; the slow motion follows the moment. Fired on reaching
  // the house line instead, it waited out to 7 s and landed at the crossing,
  // past the house.
  const hit = 6.8, flight = 0.5, FIRE_X = -31;
  const finalStrike = strikeNear(car, { height: 0.9, from: 180, flight, slope: 0.35 });
  const last = !final ? [] : [[6.2, {
    label: 'the last meteor, when the truck is at FIRE_X',
    steps: Array.from({ length: 17 }, (_, k) => [k * 0.05, (ctx) => {
      const v = truck(ctx);
      if (state.hitAt != null || !v || (v.position[0] < FIRE_X && 6.2 + k * 0.05 < 6.9)) return;
      state.hitAt = ctx.t;
      ctx.log(`the last meteor: truck at ${v.position.map((c) => c.toFixed(1)).join(', ')}`);
      finalStrike.steps[0][1](ctx);
      // Slow motion from just before it lands until the truck is in the
      // house. Half speed and no slower: the recording is 60 fps and the cut
      // 30, so below 0.5 frames repeat and the motion stutters.
      ctx.edit({ type: 'slowmo', rate: 0.5, from: ctx.t + flight - 0.35, to: ctx.t + flight + 2.6 });
    }]),
  }]];
  const traceCues = trace ? Array.from({ length: 90 }, (_, k) => [k * 0.1, (ctx) => {
    const id = ctx.e2e.snapshot()?.drivenVehicleId, v = id != null ? ctx.vehicles.get(id) : null;
    if (v) ctx.log(`truck ${JSON.stringify({ t: +(k * 0.1).toFixed(1), x: +v.position[0].toFixed(2), y: +v.position[1].toFixed(2), z: +v.position[2].toFixed(2), speed: +Math.hypot(v.velocity[0], v.velocity[2]).toFixed(1) })}`);
  }]) : [];
  // Three cameras (2026-10-06, after a take where every near miss happened
  // off screen behind a following camera, and the hit came a breath after a
  // cut):
  // - behind it, while it gets going (until the first near miss);
  // - ahead of it, on the road, looking back past it: the truck coming on and
  //   the houses going up behind it, where the near misses land;
  // - a fixed camera on the south verge east of the house it is driven into,
  //   from 1.5 s before the last meteor lands: the truck seen coming, the
  //   rock in from the left (south), the truck into the house on the right.
  // The cues all ride on the first shot (cue times run on past its end).
  const LEAD_AT = 3.0, HIT_AT = hit - 1.5;
  const chase = track(car, [-13, 4.6, 0.6], LEAD_AT, {
    name: 'the-chase', lookOffset: [9, 1.2, 0], lag: 0.3,
    cues: [...weave, steering, ...strikes, ...last, ...traceCues],
  });
  // ~17 m ahead (the lag keeps the camera ~7 m short of the offset at 23 m/s),
  // over the middle of the road, 4.5 m up: in the south lane at 3.4 m it
  // passed the front gardens' trees.
  const ahead = track(car, [24, 4.5, -1.5], HIT_AT - LEAD_AT, { name: 'ahead-of-it', lookOffset: [-6, 1.2, 0.5], lag: 0.3 });
  // The house the truck is driven into (elm-park/house-42) stands at x -17
  // on the north side, a tree (tree-57) before its west half, where the
  // meteor catches the truck. The camera stands in North Street 14 m east of
  // the house, 5 m up: the clearest lines to the truck coming on, the hit
  // and the house (the sight-line search in film/lint.mjs's terms); the
  // truck stops in the house, short of it. From the garden beside house-35,
  // that house's side wall filled a third of the frame.
  const theHit = watch([-3, 5, 46], car, 4.4, { name: 'the-hit', lookOffset: [0, 1.2, 0], lag: 0.2, lookAt: [-40, 1.5, 52] });
  return [getIn, chase, ahead, theHit];
}
