// The veneer roof at the moment it splits off, for the centre-of-mass fix
// (ChunkDef::mass_offset; server/src/wire_chunk_poses.rs). The same shot twice:
// once as clients drew it before (VIBE_DIAG_CENTROID_COM=1: the manifest
// without mass offsets, so the client weighs chunk centroids and draws the
// split-off roof displaced from the physics) and once as they draw it now.
//
//   ROOF_REEL   collapse   the two-storey, ground-floor front studs out (scene collapse-house), from tick 0
//               cannonball the city cannonball into a bungalow (scene standing)
//   ROOF_PATH   before | after: only the caption; the server env picks the path
//
//   VENEER_REEL=collapse-house VIBE_DIAG_CENTROID_COM=1 \
//   FILM_DEFINES='--define:ROOF_REEL="collapse" --define:ROOF_PATH="before"' \
//     scripts/native-mac.sh film roof-jump --scene veneer
/* global ROOF_REEL, ROOF_PATH */
import { boot, hold, fire, slowmo } from '../film/film.mjs';

const REEL = typeof ROOF_REEL === 'string' && ROOF_REEL ? ROOF_REEL : 'collapse';
const PATH = typeof ROOF_PATH === 'string' && ROOF_PATH ? ROOF_PATH : 'after';
const META = '../../structures/town-kit/out/veneer-houses/veneer-reel.meta.json';
const FRONT = -3.9;
const caption = (text, seconds, { lead = 0.1, style = 'lower', size = 'small' } = {}) => (ctx) =>
  ctx.edit({ type: 'title', style, size, text, from: ctx.t + lead, to: ctx.t + lead + seconds });

const LINE = PATH === 'before'
  ? 'BEFORE: the roof jumps up at the split (client weighed chunk centroids)'
  : 'AFTER: the roof drawn where the physics has it (client weighs centres of mass)';

function collapse() {
  // Low over the front-left corner, level with the eaves, so a gap opening
  // between the roof and the wall plates reads against the sky.
  return [hold({ position: [-7.5, 6.8, -9], lookAt: [0, 5.0, -1] }, 7, {
    name: `roof-collapse-${PATH}`,
    cues: [
      [0, caption(LINE, 6.6)],
      [0.0, slowmo(3.0, 0.25)],
    ],
  })];
}

function cannonball(houses) {
  const cx = houses.find((h) => h.id === 'bungalow-cannonball').position[0];
  return [hold({ position: [cx - 8, 4.4, -9.5], lookAt: [cx, 2.4, -1] }, 6, {
    name: `roof-cannonball-${PATH}`,
    cues: [
      [0, caption(LINE, 5.6)],
      [0, fire({ mode: 'cannonball', from: [cx - 2, 1.6, -34], at: [cx - 2, 1.4, FRONT], lead: 0.6 })],
      [0.3, slowmo(2.4, 0.25)],
    ],
  })];
}

try {
  const meta = JSON.parse(await (await fetch(`file://${META}`)).text());
  const isCollapse = REEL === 'collapse';
  const film = await boot({ scene: 'veneer', settle: isCollapse ? 0 : 4, haze: 0.3 });
  await film.play(isCollapse ? collapse() : cannonball(meta.standing), { settle: isCollapse ? 0 : 0.5 });
} catch (error) {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
}
