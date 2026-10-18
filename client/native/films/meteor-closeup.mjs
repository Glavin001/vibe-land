// Meteors up close (scripts/native-mac.sh film meteor-closeup --scene town):
// the look check for the burning rock, its fire trail and its embers on the
// WebGPU path (vfx/meteorNodes.ts). A camera on Main Street beside two Elm
// Park houses as three meteors come in from three sides and land, and the
// street after; a camera riding beside one in flight; then a barrage of
// sixteen on South Street. It logs any meteor shader built mid-film (there
// should be none: ShaderWarmup builds them). FILM_CHECK=1 for stills twice a
// second (about a minute); films/meteor-perf.mjs measures what they cost.
import { shoot, hold, strike, barrage, METEOR_FLIGHT_S } from '../film/film.mjs';

/** Where launchMeteor (film/shots.mjs) starts a meteor coming from `bearing` at `target`. */
const launchPoint = (target, bearing) => {
  const b = (bearing * Math.PI) / 180;
  return [target[0] + Math.sin(b) * 300, target[1] + 240, target[2] + Math.cos(b) * 300];
};

/**
 * A camera riding beside the meteor that lands at `target` from `bearing`:
 * `side` metres off its line of flight (horizontally, to the right of it),
 * `up` above and `ahead` along it, looking at the rock. The rock's drawn
 * position comes from the test bridge (e2e.meteors()), a frame old when the
 * pose is set, so it is carried a frame forward on its measured velocity: at
 * 140 m/s a frame is metres. Before the rock is drawn the camera waits at its
 * launch point's line, and after it lands it stays where it stopped.
 */
function ride({ target, bearing, side = 12, up = 2, ahead = 3 }, seconds, name = 'ride') {
  return {
    kind: 'ride', name, duration: seconds, cues: [], follow: false,
    build(ctx) {
      const start = launchPoint(target, bearing);
      const line = target.map((v, k) => v - start[k]);
      const len = Math.hypot(...line);
      const fwd = line.map((v) => v / len);
      // Right of the flight, horizontal.
      const h = Math.hypot(fwd[0], fwd[2]) || 1;
      const right = [-fwd[2] / h, 0, fwd[0] / h];
      let last = null, velocity = [0, 0, 0], seen = start;
      return (t) => {
        const flights = ctx.e2e.meteors?.() ?? [];
        const mine = flights
          .filter((m) => m.drawn && m.drawn.source !== 'hidden')
          .sort((a, b) => Math.hypot(...a.target.map((v, k) => v - target[k])) - Math.hypot(...b.target.map((v, k) => v - target[k])))[0];
        if (mine) {
          const p = mine.drawn.position;
          if (last && t > last.t) velocity = p.map((v, k) => (v - last.p[k]) / (t - last.t));
          const dt = last && t > last.t ? t - last.t : 0;
          if (!last || p.some((v, k) => v !== last.p[k])) last = { t, p };
          seen = p.map((v, k) => v + velocity[k] * dt);
        }
        const position = seen.map((v, k) => v + right[k] * side + fwd[k] * ahead + (k === 1 ? up : 0));
        return { position, lookAt: seen };
      };
    },
  };
}

/** The shader builds that happened after the loading screen, meteor ones by name. */
function lateShaderBuilds(ctx) {
  const late = ctx.e2e.shaderBuilds().late;
  const meteor = late.filter((b) => /meteor/i.test(b.material));
  ctx.log(`late shader builds: ${late.length} (${late.reduce((sum, b) => sum + b.ms, 0).toFixed(0)} ms), meteor: ${meteor.length}`
    + `${meteor.length ? ` (${meteor.map((b) => `${b.kind} ${b.material} ${b.ms.toFixed(0)} ms`).join(', ')})` : ''}`);
}

shoot({ scene: 'town' }, ({ place }) => {
  const house26 = place('elm-park/house-26');
  const house27 = place('elm-park/house-27');
  const house19 = place('elm-park/house-19');
  const nearHouses = hold({ position: [-35, 3.2, -3], lookAt: [-46, 4.5, 13] }, 7.5, {
    name: 'houses',
    cues: [
      // From behind the camera's left, over it into the house.
      [METEOR_FLIGHT_S + 0.2, strike({ at: house26, from: 200 })],
      // From the west, across the frame.
      [4.2, strike({ at: house27, from: 290 })],
      // From the north-east, toward the camera, into the lawn between them.
      [5.4, strike({ at: [-43, 0.6, 8], from: 40 })],
    ],
  });
  // Main Street's south side, from the east, ridden in from its launch.
  const t19 = [house19.position[0], Math.min(house19.top * 0.6, 12), house19.position[2]];
  const riding = ride({ target: t19, bearing: 90, side: 12, up: 2, ahead: 3 }, 4.4);
  riding.cues = [[3.0, strike({ at: house19, from: 90 })]];
  const aftermath = hold({ position: [-40, 2.6, 1.5], lookAt: [-48, 2.5, 13] }, 3, { name: 'aftermath' });
  // Sixteen in the air at once over both sides of South Street.
  const south = place.all.filter((p) => p.kind === 'house' && p.street === 'South Street')
    .sort((a, b) => a.position[0] - b.position[0]);
  const storm = hold({ position: [-42, 26, -100], lookAt: [-42, 6, -48] }, 6.5, {
    name: 'barrage',
    cues: [
      [METEOR_FLIGHT_S + 0.6, barrage([...south, ...south].slice(0, 16), { every: 0.12 })],
      // Every meteor shader built behind the loading screen (ShaderWarmup), none mid-film.
      [6.4, lateShaderBuilds],
    ],
  });
  return [nearHouses, aftermath, riding, storm];
});
