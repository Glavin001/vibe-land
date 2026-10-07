// Vibe Town destruction for judging an engine profile (scripts/native-mac.sh
// film hifi-showcase --scene town): the chase (films/chase-shots.mjs: the
// monster truck weaving east through Elm Park as meteors blow the houses
// either side apart, then a meteor that throws it into a house), then the
// street after, held from above. Captions carry the profile (HIFI_NOTE, e.g.
// "high fidelity" or "runtime") and what was measured: the town's broken
// joints and crushed chunks at the moment of the hit and at the end.
//
//   TOWN_PACK=structures/vibe-town/out/vibe-town-crush-real \
//   FILM_DEFINES='--define:HIFI_NOTE="high_fidelity"' scripts/native-mac.sh film hifi-showcase --scene town
/* global HIFI_NOTE */
import { shoot } from '../film/film.mjs';
import { hold } from '../film/shots.mjs';
import { chaseShots } from './chase-shots.mjs';

// Spaces travel as underscores (the film's defines are split on whitespace).
const NOTE = typeof HIFI_NOTE === 'string' ? HIFI_NOTE.replace(/_/g, ' ') : '';
const city = (ctx) => ctx.e2e?.snapshot()?.city ?? {};
const measured = (ctx, before) => {
  const c = city(ctx);
  const broken = (c.brokenBonds ?? 0) - before.broken, crushed = (c.dust?.crushes ?? 0) - before.crushed;
  return `${broken} joints broken${crushed ? ` · ${crushed} chunks crushed` : ''}`;
};

shoot({ scene: 'town', shake: { strength: 0.5, radius: 90 } }, ({ place }) => {
  const shots = chaseShots(place, { trace: true });
  const before = { broken: 0, crushed: 0 };
  // The first shot: the profile, and the town's count before the chase.
  shots[0].cues = [[0, (ctx) => {
    const c = city(ctx);
    before.broken = c.brokenBonds ?? 0; before.crushed = c.dust?.crushes ?? 0;
    ctx.log(`measure-town ${JSON.stringify({ at: 'start', brokenBonds: before.broken, crushes: before.crushed })}`);
    ctx.edit({ type: 'title', style: 'lower', size: 'small', text: `Vibe Town · the monster truck and meteors${NOTE ? ` · ${NOTE}` : ''}`, from: ctx.t + 0.2, to: ctx.t + 1.4 });
  }], ...(shots[0].cues ?? [])];
  // The hit's shot: what the chase has done so far, as the truck goes in.
  const hit = shots.at(-1);
  hit.cues = [...(hit.cues ?? []), [3.0, (ctx) => {
    ctx.log(`measure-town ${JSON.stringify({ at: 'hit', text: measured(ctx, before) })}`);
    ctx.edit({ type: 'title', style: 'lower', size: 'small', text: measured(ctx, before), from: ctx.t, to: ctx.t + 1.4 });
  }]];
  // After: North Street from above the house the truck went into, held while
  // the rubble settles, the count at the end.
  const north = place('street/north-street').position[2];
  const after = hold({ position: [12, 22, north - 22], lookAt: [-30, 1, north + 4] }, 5, {
    name: 'after',
    cues: [[4.0, (ctx) => {
      const c = city(ctx);
      ctx.log(`measure-town ${JSON.stringify({ at: 'end', brokenBonds: c.brokenBonds ?? 0, crushes: c.dust?.crushes ?? 0, text: measured(ctx, before) })}`);
      ctx.edit({ type: 'title', style: 'lower', size: 'small', text: `after: ${measured(ctx, before)}${NOTE ? ` · ${NOTE}` : ''}`, from: ctx.t, to: ctx.t + 1.0 });
    }]],
  });
  return [...shots, after];
});
