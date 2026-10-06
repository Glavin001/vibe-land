// Vibe Town: the trailer (FILM_FPS=60 FILM_SIZE=1920x1080 scripts/native-mac.sh
// film trailer --scene town; FILM_PREVIEW=1 for a still of each shot).
// An action-movie trailer: a quiet open, then destruction all around the
// camera -- the towers, a run down Main Street through exploding shops, the
// market square, a faster run through Elm Park, a car thrown, and the rise
// over a town under a meteor storm. Recorded at 60 fps so slow-motion spans
// keep every frame; the cut (titles, cards, flashes, letterbox, slow motion)
// is applied after recording (scripts/film/post.py) from the edit list.
//
// Every strike is timed by when it LANDS (strike/barrage: 2.74 s after
// launch), most of them just ahead of a moving camera: `landAhead` puts a
// building's impact `lead` metres before the camera reaches it.
import { shoot, hold, path, orbit, strike, barrage, title, card, slowmo, flash, fade, goto } from '../film/film.mjs';
import { chaseShots } from './chase-shots.mjs';

// No haze: from altitude the far ground fades white under it. The high
// shots look steeply down instead (~55 degrees at the top of the rise), so
// even with the letterbox the horizon -- and the ground plane's far edge
// below it -- stays out of frame.
shoot({ scene: 'town', shake: { strength: 1.1, radius: 120 }, letterbox: 2.39 }, ({ place }) => {
  const all = place.all;
  const towers = (n) => place(`market-quarter/tower-${n}`);
  /** Buildings along a street side, ordered by x (west first). */
  const row = (street, side, kinds = ['shop', 'grocery', 'cinema', 'library']) => all
    .filter((p) => kinds.includes(p.kind) && p.street === street && p.side === side)
    .sort((a, b) => a.position[0] - b.position[0]);
  /** Elm Park houses on a street side (west first). */
  const houses = (street, side) => all
    .filter((p) => p.kind === 'house' && p.street === street && p.side === side)
    .sort((a, b) => a.position[0] - b.position[0]);

  /**
   * Cues for a camera running along x at `speed` m/s from x0 starting at the
   * shot's t=0: each building struck as the camera comes within `lead` m of
   * it (westward runs: the camera's x falls).
   */
  const landAhead = (buildings, { x0, speed, lead = 16, from = 0.3, until = Infinity, every = 0 }) => buildings
    .map((b, k) => [(x0 - b.position[0] - lead) / speed + k * every, strike({ at: b })])
    .filter(([t]) => t >= from && t <= until);

  // ---------------------------------------------------------------- 1. cold open
  // Main Street's east end at eye height, creeping west: still, peaceful.
  const open = [
    { position: [148, 1.8, -1.5], lookAt: [100, 4, 1] },
    { position: [141, 1.9, -1.2], lookAt: [96, 6, 0] },
  ];
  const coldOpen = path(open, 6, {
    name: 'cold-open', ease: 'none',
    cues: [
      [0, fade('in', 1.2)],
      [0.8, title('THEY BUILT A TOWN', 2.8)],
      // The tower beside the camera, top storeys: flash, shake, slow motion.
      [4.6, strike({ at: towers(3), height: 24, flash: true })],
      [4.4, slowmo(1.6, 0.5)],
    ],
  });

  // ---------------------------------------------------------------- 2. the towers
  const t2 = towers(2).position, t1 = towers(1).position;
  const towerFall = path([
    { position: [124, 2.2, -2.5], lookAt: [t2[0], 20, t2[2]] },
    { position: [114, 3.5, 1.5], lookAt: [t2[0] - 4, 16, t2[2]] },
    { position: [101, 5, 3], lookAt: [t1[0], 14, t1[2]] },
  ], 5.8, {
    name: 'towers',
    cues: [
      [0.5, strike({ at: towers(2), height: 27 })],
      [1.1, strike({ at: towers(2), height: 14, flash: true })],
      [1.0, slowmo(1.4, 0.5)],
      [2.6, strike({ at: towers(1), height: 26 })],
      [3.2, strike({ at: towers(1), height: 12 })],
      [3.9, strike({ at: towers(3), height: 9 })],
    ],
  });

  // ---------------------------------------------------------------- 3. Main Street run
  // West down Main Street at 3.4 m, 9 m/s: shops north, the bus station and
  // a grocer south, each hit just ahead of the camera.
  const runX0 = 78, runSpeed = 9, runSeconds = 9.8;
  const mainRun = path([
    { position: [runX0, 3.6, -0.5], lookAt: [runX0 - 30, 3, 0.5] },
    { position: [runX0 - runSpeed * runSeconds * 0.5, 3.2, 0.8], lookAt: [runX0 - runSpeed * runSeconds * 0.5 - 30, 2.6, -0.5] },
    { position: [runX0 - runSpeed * runSeconds, 3.8, -0.8], lookAt: [runX0 - runSpeed * runSeconds - 30, 2.4, 1] },
  ], runSeconds, {
    name: 'main-street-run', ease: 'none',
    cues: [
      ...landAhead(row('Main Street', 'north'), { x0: runX0, speed: runSpeed, lead: 14 }),
      ...landAhead(row('Main Street', 'south', ['grocery']), { x0: runX0, speed: runSpeed, lead: 12 }),
      // The bus station: the three shelters at once, in slow motion.
      [(runX0 - 20 - 14) / runSpeed, barrage([[12, 1.2, -8.2], [20, 1.2, -8.2], [28, 1.2, -8.2]], { every: 0.12 })],
      [(runX0 - 20 - 14) / runSpeed - 0.2, slowmo(1.2, 0.5)],
      [(runX0 - 20 - 14) / runSpeed, flash(0.12)],
    ],
  });

  // ---------------------------------------------------------------- 4. the market square
  // A hard cut into the square between the shop rows, gliding west low over
  // the stalls as they and the North Street shops behind them go up.
  const market = path([
    { position: [62, 6, 23.5], lookAt: [30, 2.5, 23.5] },
    { position: [40, 4.2, 24.5], lookAt: [10, 2, 23] },
    { position: [14, 5.5, 23.5], lookAt: [-10, 3, 20] },
  ], 6, {
    name: 'market-square', ease: 'none',
    cues: [
      ...[42, 32, 22, 12].map((x, k) => [0.9 + k * 1.05, strike({ at: [x, 1.4, 22.5] })]),
      ...landAhead(row('North Street', 'south'), { x0: 62, speed: 8, lead: 10, until: 5.6 }),
    ],
  });

  // ---------------------------------------------------------------- 5. Elm Park run
  // Faster, lower: west down Main Street through Elm Park, the houses either
  // side blown apart just ahead, the driveway car thrown. The player rides
  // under the camera so the cars are there to be thrown.
  const parkX0 = -6, parkSpeed = 14, parkSeconds = 9.6;
  const car4 = place('car-4').position;
  const parkRun = path([
    { position: [parkX0, 2.8, 0.6], lookAt: [parkX0 - 30, 2.4, 0] },
    { position: [parkX0 - parkSpeed * parkSeconds * 0.5, 2.5, -0.8], lookAt: [parkX0 - parkSpeed * parkSeconds * 0.5 - 30, 2.2, 1] },
    { position: [parkX0 - parkSpeed * parkSeconds, 3.2, 0.5], lookAt: [parkX0 - parkSpeed * parkSeconds - 30, 3, 0] },
  ], parkSeconds, {
    name: 'elm-park-run', ease: 'none', player: 'camera',
    cues: [
      ...landAhead(houses('Main Street', 'north'), { x0: parkX0, speed: parkSpeed, lead: 20 }),
      ...landAhead(houses('Main Street', 'south'), { x0: parkX0, speed: parkSpeed, lead: 26 }),
      // Beside car-4: it goes over, in slow motion.
      [(parkX0 - car4[0] - 12) / parkSpeed, strike({ at: [car4[0] - 3, 0.6, car4[2] + 2.5], flash: true })],
      [(parkX0 - car4[0] - 12) / parkSpeed - 0.15, slowmo(1.5, 0.5)],
    ],
  });

  // ---------------------------------------------------------------- 6. the car
  // Round a parked car at bonnet height as its house, then the street beside it, is hit.
  const car1 = place('car-1');
  const carHouse = place('house', { nearest: [car1.position[0] - 7.7, car1.position[2] + 2.5] });
  // From the street side (bearings 110-200: east round to south), its house
  // behind it, far enough out that the car stays in frame when it is thrown.
  const theCar = orbit({ centre: car1, radius: 16, height: 4, from: 110, to: 200, lookHeight: 1.6 }, 5, {
    name: 'the-car',
    cues: [
      [0, goto([car1.position[0] + 6, 1.2, car1.position[2] - 9])],
      [1.2, strike({ at: carHouse, flash: true })],
      [2.4, strike({ at: [car1.position[0] + 1.5, 0.5, car1.position[2] + 3.5] })],
      [2.2, slowmo(1.8, 0.5)],
    ],
  });

  // ---------------------------------------------------------------- 7. the chase
  // The monster truck through Elm Park, houses going up either side, then
  // the truck itself (films/chase-shots.mjs).
  const [getIn, chase, theHit] = chaseShots(place, { title: 'RUN', trace: true });

  // ---------------------------------------------------------------- 8. the rise
  // Straight up out of Elm Park and back over the whole town while a storm
  // falls on both districts: every tower, the cinema, the library, rows of houses.
  const storm = [
    ...houses('North Street', 'south'), ...houses('North Street', 'north'),
    ...houses('South Street', 'north'), ...houses('South Street', 'south'),
    towers(4), towers(5), place('market-quarter/cinema-1'), place('market-quarter/library-1'),
    ...row('South Street', 'north'), ...row('North Street', 'south').slice(0, 3),
  ].filter((p, k) => k % 2 === 0);
  const rise = path([
    { position: [-118, 2.5, -40], lookAt: [-100, 8, -10] },
    { position: [-112, 30, -62], lookAt: [-80, 0, -10] },
    { position: [-95, 62, -95], lookAt: [-62, 0, -35] },
    { position: [-72, 100, -92], lookAt: [-42, 0, -30] },
  ], 10, {
    name: 'the-rise', ramp: 0.2,
    cues: [
      [1.0, barrage(storm, { every: 0.22 })],
      [8.0, title('VIBE TOWN', 3.6, { size: 'big' })],
    ],
  });

  // ---------------------------------------------------------------- 9. the end
  const last = { position: [-72, 100, -92], lookAt: [-42, 0, -30] };
  const end = hold(last, 4.2, {
    name: 'end',
    cues: [[1.4, fade('out', 1.2)], [2.6, card('DESTROY EVERYTHING', 1.6)]],
  });

  // Cards between the acts: the picture keeps running underneath, hidden.
  const between = (text, seconds, pose) => hold(pose, seconds, { name: `card-${text.toLowerCase().replace(/\W+/g, '-')}`, cues: [[0, card(text, seconds)]] });
  // The chase comes before Elm Park's other destruction: it was measured on a
  // clean North Street (chase-shots.mjs RUN), and the Main Street run's
  // rubble, thrown that far, stopped the truck short of its meteor.
  return [
    coldOpen,
    between('TO LAST', 1.2, open[1]),
    towerFall,
    between('THEY WERE WRONG', 1.2, { position: [101, 5, 3], lookAt: [t1[0], 14, t1[2]] }),
    mainRun,
    market,
    getIn,
    chase,
    theHit,
    between('NOWHERE IS SAFE', 1.4, { position: [-6, 3, 0.6], lookAt: [-36, 2.4, 0] }),
    parkRun,
    theCar,
    rise,
    end,
  ];
});
