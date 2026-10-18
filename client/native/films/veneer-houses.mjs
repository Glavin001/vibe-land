// The town kit's brick-veneer houses, how they stand and how they come down
// (scripts/veneer-reel.sh, which films the three parts and splices them):
//
//   VENEER_REEL=standing           each house as built (an orbit), then its frame
//                                  alone (brick and board removed), then the city
//                                  cannonball and meteor into a bungalow
//   VENEER_REEL=collapse-bungalow  the bungalow with its front-wall studs out, from tick 0
//   VENEER_REEL=collapse-house     the two-storey with its ground-floor front studs out
//
//   VENEER_REEL=standing FILM_DEFINES='--define:VENEER_REEL="standing"' \
//     scripts/native-mac.sh film veneer-houses --scene veneer
//
// Scenes: structures/town-kit/scripts/build-veneer-reel.mjs (houses 30 m apart
// along x, fronts facing -z, front brick face at z -3.9). Captions carry what
// was measured: the scene's broken bonds (each shot's own, as a difference),
// and for a collapse how far the front of the roof came down (the highest
// chunk drawn over the front slope, from the drawn-world sample).
/* global VENEER_REEL */
import { boot, hold, orbit, fire, strike } from '../film/film.mjs';

const REEL = typeof VENEER_REEL === 'string' && VENEER_REEL ? VENEER_REEL : 'standing';
const META = '../../structures/town-kit/out/veneer-houses/veneer-reel.meta.json';
const FRONT = -3.9;
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const broken = (ctx) => ctx.e2e.snapshot()?.city?.brokenBonds ?? 0;
const caption = (text, seconds, { lead = 0.2 } = {}) => (ctx) => ctx.edit({ type: 'title', style: 'lower', size: 'small', text, from: ctx.t + lead, to: ctx.t + lead + seconds });

/**
 * The front roof's tiles: the mean height of the roof-covering chunks over
 * the front slope (the scene pack's node types; the drawn-world sample's slots
 * are its chunks, a rotating subset each frame, so each tile keeps the last
 * height it was drawn at), measured over two windows.
 */
function roofMeter(pack) {
  const s = pack.scenario, tiles = new Set();
  s.nodeTypes.forEach((t, i) => { if (t === 'roof-covering' && s.nodes[i].centroid.z < -0.5) tiles.add(i); });
  const seen = new Map();
  const sample = (ctx) => {
    const c = ctx.e2e.drawnWorld?.()?.city;
    if (!c) return;
    c.slots.forEach((slot, i) => { if (tiles.has(slot)) seen.set(slot, c.positions[3 * i + 1]); });
  };
  const mean = () => { const v = [...seen.values()]; return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  return {
    tiles: tiles.size,
    window(t0, t1, into) {
      const cues = [[t0, () => seen.clear()]];
      for (let t = t0; t <= t1 + 1e-6; t += 1 / 30) cues.push([t, sample]);
      cues.push([t1 + 0.01, (ctx) => { into.value = mean(); ctx.log(`roof tiles seen ${seen.size} of ${tiles.size}: mean height ${into.value.toFixed(2)} m`); }]);
      return cues;
    },
  };
}

/** An orbit of a standing house, captioned with what it is and what broke while filmed. */
function standing(house, { label, what, seconds, radius, height, lookHeight }) {
  const start = { value: 0 }, lines = [label, ...what], each = (seconds * 0.62) / lines.length;
  return orbit({ centre: [house.position[0], 0, 0], radius, height, from: 150, to: 290, lookHeight }, seconds, {
    name: house.id,
    cues: [
      [0, (ctx) => { start.value = broken(ctx); }],
      ...lines.map((line, k) => [k * each, caption(line, each - 0.25, { lead: k ? 0 : 0.2 })]),
      [seconds * 0.64, (ctx) => {
        const n = broken(ctx) - start.value;
        caption(`Stands: ${fmt(n)} of ${fmt(house.bonds)} bonds broken in ${seconds.toFixed(0)} s`, seconds * 0.34, { lead: 0 })(ctx);
      }],
    ],
  });
}

function standingReel(houses) {
  const at = (id) => houses.find((h) => h.id === id);
  const cannon = at('bungalow-cannonball'), rock = at('bungalow-meteor');
  const engine = "Today's engine: a hit loads the whole frame at once";
  const hit = (house, label, seconds) => {
    const start = { value: 0 };
    return [
      [0, (ctx) => { start.value = broken(ctx); }],
      [seconds - 2.6, (ctx) => {
        const n = broken(ctx) - start.value;
        caption(`${label}: ${fmt(n)} of ${fmt(house.bonds)} bonds broken`, 2.5, { lead: 0 })(ctx);
      }],
    ];
  };
  const cx = cannon.position[0], mx = rock.position[0];
  return [
    standing(at('bungalow'), { label: 'Brick-veneer bungalow, as built', what: ['A C24 timber stud frame carries the roof', '90 mm brick on the slab, tied to the studs', 'Gypsum board screwed inside'], seconds: 11, radius: 14, height: 5, lookHeight: 1.9 }),
    standing(at('bungalow-frame'), { label: 'The bungalow, frame only', what: ['Brick veneer and drywall removed'], seconds: 9, radius: 12, height: 4.5, lookHeight: 1.8 }),
    standing(at('house'), { label: 'Brick-veneer two-storey, as built', what: ['Platform framing: the upper storey on a doubled rim', 'Brick two storeys high, tied to both frames'], seconds: 11, radius: 18, height: 7.5, lookHeight: 3.2 }),
    standing(at('house-frame'), { label: 'The two-storey, frame only', what: ['Brick veneer and drywall removed'], seconds: 9, radius: 15, height: 6.5, lookHeight: 3 }),
    hold({ position: [cx - 13, 5, -14], lookAt: [cx, 1.4, -1] }, 6, {
      name: 'cannonball',
      cues: [
        [0, caption('The city cannonball, 10.6 t at 60 m/s, into a bungalow', 1.6)],
        [1.8, caption(`${engine} (a new impact model is coming)`, 1.5, { lead: 0 })],
        [0, fire({ mode: 'cannonball', from: [cx - 2, 1.6, -34], at: [cx - 2, 1.4, FRONT], lead: 0.6 })],
        ...hit(cannon, 'Cannonball', 6),
      ],
    }),
    hold({ position: [mx - 16, 6.5, -18], lookAt: [mx, 1.8, 0] }, 7, {
      name: 'meteor',
      cues: [
        [0, caption('The city meteor into a bungalow', 1.6)],
        [1.8, caption(`${engine} (a new impact model is coming)`, 1.7, { lead: 0 })],
        [3.2, strike({ at: [mx, 2, FRONT], from: 180, slope: 0.3 })],
        ...hit(rock, 'Meteor', 7),
      ],
    }),
  ];
}

function collapseReel(house, pack) {
  const two = house.variant.startsWith('veneer-house');
  const seconds = 10, before = { value: NaN }, after = { value: NaN };
  const meter = roofMeter(pack);
  const label = two ? 'The two-storey, front-wall studs removed (both storeys)' : 'The bungalow, front-wall studs removed';
  // From high on the front-left corner: the front slope falls in behind the brick, which stands.
  return [hold(two ? { position: [-11, 9.5, -14.5], lookAt: [0, 3.4, -1] } : { position: [-11, 7.5, -13], lookAt: [0, 2.2, -1] }, seconds, {
    name: house.id,
    cues: [
      [0, caption(label, 2.6)],
      [2.9, caption('studs, king, jack and cripple studs out; nothing else changed', 2.6, { lead: 0 })],
      ...meter.window(0, 0.4, before),
      ...meter.window(seconds - 1.9, seconds - 1.25, after),
      [seconds - 1.15, (ctx) => {
        const n = broken(ctx);
        ctx.log(`collapse ${house.id}: broken ${n} of ${house.bonds}; front roof tiles ${before.value.toFixed(2)} -> ${after.value.toFixed(2)} m`);
        caption(`Comes down: ${fmt(n)} of ${fmt(house.bonds)} bonds broken · front roof ${before.value.toFixed(1)} m -> ${after.value.toFixed(1)} m`, 1.1, { lead: 0 })(ctx);
      }],
    ],
  })];
}

try {
  const meta = JSON.parse(await (await fetch(`file://${META}`)).text());
  const houses = meta[REEL];
  if (!houses) throw new Error(`no reel ${REEL} in ${META}`);
  const collapse = REEL.startsWith('collapse');
  // A collapse starts on the first tick: no settling before the camera rolls.
  const film = await boot({ scene: 'veneer', settle: collapse ? 0 : 4, haze: 0.3 });
  const pack = collapse ? JSON.parse(await (await fetch(`file://${META.replace('veneer-reel.meta.json', `veneer-reel-${REEL}.json`)}`)).text()) : null;
  await film.play(collapse ? collapseReel(houses[0], pack) : standingReel(houses), { settle: collapse ? 0 : 0.5 });
} catch (error) {
  console.log(`[film] FAILED: ${error?.stack ?? error}`);
  setTimeout(() => process.exit(1), 300);
}
