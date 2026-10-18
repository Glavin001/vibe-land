// A short film of Vibe Town's Elm Park (scripts/native-mac.sh film
// elm-park-tour --scene town; FILM_PREVIEW=1 for a still of each shot): the
// approach from the air, a glide down North Street between the houses, round
// a car parked in its driveway, a cannon on one house and a meteor on the
// next, then the pull-back over the park. Places: structures/vibe-town's
// .meta.json (client/native/film/places.mjs).
import { shoot, hold, path, orbit, fire, meteor } from './film/film.mjs';

shoot({ scene: 'town' }, ({ place }) => {
  const north = place('street/north-street').position[2];
  const car = place('car', { nearest: [-26, 35] });
  const house = place('house', { nearest: [-51, 16] });
  const nextHouse = place('house', { nearest: [-34, 16] });
  const opening = { position: [-215, 75, -135], lookAt: [-80, 0, -5] };
  const pavement = { position: [-36, 3.5, 1], lookAt: house };
  const meteorView = { position: [-12, 14, -14], lookAt: [nextHouse.position[0] - 2, 3, nextHouse.position[2] - 2] };
  return [
    hold(opening, 1, { name: 'opening' }),
    // Swing north over the park, down to North Street and along it, houses either side.
    path([
      opening,
      { position: [-165, 40, north - 8], lookAt: [-120, 0, north - 2] },
      { position: [-158, 7, north], lookAt: [-118, 3, north] },
      { position: [-136, 3.4, north], lookAt: [-100, 2.6, north] },
      { position: [-74, 3.2, north - 0.5], lookAt: [-40, 2.6, north - 1] },
      { position: [-12, 3.2, north - 1], lookAt: [20, 2.6, north - 2] },
    ], 19, { name: 'north-street', player: [car.position[0], 1.2, north - 5] }), // so the car is streamed in
    // Round the car's bonnet from the front garden, the houses either side.
    orbit({ centre: car, radius: 7, height: 2.2, from: -40, to: 45 }, 6, { name: 'driveway-car' }),
    // Up over the roofs and down to the pavement across Main Street as the player takes aim.
    path([
      { position: [-21.35, 2.2, 39.95], lookAt: car },
      { position: [-25, 10, 39], lookAt: [-34, 3, 20] },
      { position: [-27, 17, 27], lookAt: house },
      pavement,
    ], 3.5, {
      name: 'over-the-roofs',
      cues: [[0, fire({ mode: 'cannonball', from: [house.position[0], 1.2, -2], at: house, shots: 5, every: 0.85, lead: 3.5 })]],
    }),
    hold(pavement, 5.5, { name: 'cannon' }),
    path([pavement, meteorView], 1.5, { name: 'to-the-meteor', cues: [[1.3, meteor({ at: nextHouse })]] }),
    hold(meteorView, 7, { name: 'meteor' }),
    path([meteorView, { position: [-70, 70, -120], lookAt: [-72, 0, 5] }], 7, { name: 'pull-back' }),
  ];
});
