// The brick-veneer two-storey's stair, walked: the player goes from the hall
// up the switchback (lower flight, half landing, upper flight) onto the upper
// floor and back down, seen through the player's eyes; then the same walk in
// the house's frame alone, and down into its stairwell from the upper floor. The stair is structures/town-kit
// stairs-timber.mjs; its walk is the house metadata's `route`, which
// scripts/perf/walk_route.py walks with the server's player as a test.
//
//   VIBE_PLAYER_SNAP_TO_GROUND=1 VENEER_REEL=stairs FILM_FPS=60 \
//     scripts/native-mac.sh film veneer-stairs --scene veneer
//
// VIBE_PLAYER_SNAP_TO_GROUND=1: the server's PhysX player snaps to ground
// (MoveConfig.snap_to_ground, 0.2 m) and walks down the treads; without it
// the player leaves them at walking speed. The scene
// (structures/town-kit/scripts/build-veneer-reel.mjs `stairs`): the house at
// x 0 and its frame at x 30, fronts facing -z.
import { boot, hold, path, slowmo } from '../film/film.mjs';

const META = '../../structures/town-kit/out/veneer-houses/veneer-reel.meta.json';
const EYE = 0.72;          // camera over the capsule's centre (its top is +0.8)
const caption = (ctx, text, from, seconds) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text, from, to: from + seconds });

/**
 * The player walks `route` (feet points), steered at each point in turn with
 * walking input (the drive bridge: look and move, as a player would); the
 * camera is the player's eyes, smoothed. `notes`: captions, by point name,
 * shown when the player reaches it.
 */
function walk(route, seconds, { name, notes = {}, cues = [] }) {
  // `live` from the shot's first cue: the film also evaluates every shot's
  // poses before it plays (its camera checks), and the walk must not start then.
  let ctx = null, start = 0, live = false;
  return {
    kind: 'walk', name, duration: seconds, follow: false,
    cues: [[0, (c) => { start = c.t; live = true; }], ...cues],
    build(c) {
      ctx = c;
      let phase = 'drop', next = 1, settled = 0, eye = null, look = null, last = null, reachedAt = [];
      const lerp = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
      return (t) => {
        if (!live) {
          const [hx, hy, hz] = route[0].at, [nx, ny, nz] = route[1].at;
          return { position: [hx, hy + 0.8 + EYE, hz], lookAt: [nx, ny + 0.8 + EYE, nz] };
        }
        const snap = ctx.e2e.snapshot();
        const p = snap?.position;
        const [hx, hy, hz] = route[0].at;
        if (phase === 'drop') {
          const [nx, , nz] = route[1].at;
          ctx.e2e.dropAt({ position: [hx, hy + 0.85, hz], yaw: Math.atan2(nx - hx, nz - hz), pitch: 0 });
          ctx.drive.stop();
          phase = 'arrive';
        } else if (phase === 'arrive' && p) {
          const near = Math.hypot(p[0] - hx, p[2] - hz) < 0.4 && Math.abs(p[1] - 0.8 - hy) < 0.3 && snap.onGround;
          settled = near ? settled + 1 : 0;
          if (settled > 20) { phase = 'walk'; ctx.log(`walk: at ${route[0].name}, ${t.toFixed(2)} s`); }
        } else if (phase === 'walk' && p) {
          const feet = p[1] - 0.8, goal = route[next].at;
          if (Math.hypot(goal[0] - p[0], goal[2] - p[2]) < 0.25 && Math.abs(feet - goal[1]) < 0.3) {
            const at = route[next].name;
            ctx.log(`walk: ${at} at ${t.toFixed(2)} s, feet ${p.map((v, i) => (i === 1 ? v - 0.8 : v).toFixed(2)).join(', ')}, on the ground ${snap.onGround}`);
            reachedAt.push(at);
            if (notes[at]) caption(ctx, notes[at][0], start + t, notes[at][1]);
            next += 1;
            if (next >= route.length) { phase = 'done'; ctx.drive.stop(); ctx.log(`walk: done, ${reachedAt.length + 1} of ${route.length} points`); }
          }
          if (phase === 'walk') {
            const g = route[next].at;
            ctx.drive.lookAt(g[0], p[1], g[2]);
            ctx.drive.move({ forward: 1 });
          }
        }
        // The camera: the player's eyes, looking ahead to the next point at eye height over it.
        const here = p ?? [hx, hy + 0.8, hz];
        const target = route[Math.min(next, route.length - 1)].at;
        const want = [here[0], here[1] + EYE, here[2]];
        const ahead = [target[0], target[1] + 0.8 + EYE - 0.25, target[2]];
        const dt = last == null ? 0 : Math.max(0, t - last);
        last = t;
        eye = eye ? lerp(eye, want, 1 - Math.exp(-dt / 0.06)) : want;
        look = look ? lerp(look, ahead, 1 - Math.exp(-dt / 0.22)) : ahead;
        // Never look straight down or up: keep the look point at least a metre off across.
        const flat = Math.hypot(look[0] - eye[0], look[2] - eye[2]);
        const lookAt = flat > 1 ? look : [eye[0] + (look[0] - eye[0]) / Math.max(flat, 1e-3), look[1], eye[2] + (look[2] - eye[2]) / Math.max(flat, 1e-3)];
        return { position: eye, lookAt };
      };
    },
  };
}

try {
  const meta = JSON.parse(await (await fetch(`file://${META}`)).text());
  const houses = meta.stairs;
  if (!houses) throw new Error(`no stairs scene in ${META} (structures/town-kit/scripts/build-veneer-reel.mjs)`);
  const house = houses.find((h) => h.id === 'house'), frame = houses.find((h) => h.id === 'house-frame');
  const film = await boot({ scene: 'veneer', settle: 4, haze: 0.3 });
  const hx = house.position[0], fx = frame.position[0];
  // Captions at the points the player reaches, each gone before the next (the walk takes ~3.2 s).
  const notes = {
    'stair-foot': ['Timber switchback: 15 risers of 186.5 mm on a 270 mm going (IRC R311.7)', 0.58],
    'landing-arrive': ['A half landing after 7 risers, then 8 more back the other way', 0.78],
    'stair-head': ['Onto the upper floor through the trimmed opening, and back down on the treads', 1.25],
  };
  await film.play([
    hold({ position: [hx + 9, 4.5, -15], lookAt: [hx, 2.4, 0] }, 3, {
      name: 'house',
      cues: [[0.2, (ctx) => caption(ctx, 'Brick-veneer two-storey: a stair inside the front door', ctx.t, 2.6)]],
    }),
    // Walking speed is the game's 6 m/s: the walk at half speed.
    walk(house.route, 3.8, { name: 'walk', notes, cues: [[0, slowmo(3.8, 0.5)]] }),
    // The same walk in the house's frame alone (brick and board removed): the stair's timbers around it.
    walk(frame.route, 3.8, {
      name: 'walk-frame',
      notes: { 'stair-foot': ['The frame alone: housed stringers, treads and risers', 0.58], 'landing-arrive': ['The landing: rims and joists on posts', 0.78], 'stair-head': ['The opening: doubled trimmers and a doubled header, tails in hangers', 1.25] },
      cues: [[0, slowmo(3.8, 0.5)]],
    }),
    // From the upper floor, behind the opening's header, down into the stairwell.
    path([{ position: [fx + 1.8, 4.3, -0.6], lookAt: [fx - 0.4, 0.9, -2.9] }, { position: [fx + 0.4, 4.1, -0.8], lookAt: [fx - 0.6, 0.8, -3.0] }], 5, {
      name: 'stairwell',
      cues: [[0.2, (ctx) => caption(ctx, 'Stringers hung from the landing rim and the trimmer; the landing on posts', ctx.t, 4.6)]],
    }),
  ], { settle: 0.5 });
} catch (error) {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
}
