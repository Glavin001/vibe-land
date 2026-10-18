// What meteors cost to draw (scripts/native-mac.sh film meteor-perf --scene
// town): two storms of sixteen, launched 0.15 s apart onto the open field
// south of Elm Park and watched from 50 m -- the first as the game draws
// them, the second with the fire and the embers switched off (their shared
// materials hidden), so the difference between the two is what those cost.
// The stats lines' renderMs (the frame's JavaScript and draw submission) and
// wallMs (the whole frame, GPU included) while the rocks are in the air --
// from 0.5 s to about 5.5 s into each storm shot -- against the `calm` shot.
// The first storm wakes the field for the second, so compare each from the
// settled world: FILM_SHOTS=calm,storm and FILM_SHOTS=calm,storm-bare.
import { shoot, hold, barrage, METEOR_FLIGHT_S } from '../film/film.mjs';

/** Show or hide every material of the meteor's fire and embers (vfx/meteorNodes.ts names them). */
const showFireAndEmbers = (on) => (ctx) => {
  const scene = globalThis.__VIBE_NATIVE_STORE__?.getState?.().scene;
  const names = new Set(['Meteor fire (TSL)', 'Meteor embers (TSL)']);
  let found = 0;
  scene?.traverse((object) => {
    if (object.material && names.has(object.material.name)) { object.material.visible = on; found += 1; }
  });
  ctx.log(`fire and embers ${on ? 'shown' : 'hidden'} (${found} meshes)`);
};

shoot({ scene: 'town' }, () => {
  const pose = { position: [-20, 14, -92], lookAt: [-20, 8, -140] };
  const field = (x0) => {
    const points = [];
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) points.push([x0 + i * 10, 0.5, -128 - j * 10]);
    return points;
  };
  const storm = (name, x0, on) => hold(pose, 9, {
    name,
    cues: [
      [0, showFireAndEmbers(on)],
      [METEOR_FLIGHT_S + 0.5, barrage(field(x0), { every: 0.15, height: 0.5 })],
    ],
  });
  return [hold(pose, 3, { name: 'calm' }), storm('storm', -35, true), storm('storm-bare', -35, false)];
});
