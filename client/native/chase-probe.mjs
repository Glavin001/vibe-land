// The chase (films/chase-shots.mjs) with the truck's server-side state logged
// every 0.05 s: what breaks on it, when, and what was near it (the meteors in
// flight). For the vehicle test bed's reproduction of the chase report
// (structures/vehicle-lab/README.md): FILM_CHECK=1 scripts/native-mac.sh film chase-probe --scene town
import { shoot } from './film/film.mjs';
import { chaseShots } from './films/chase-shots.mjs';

/** The truck is the town fleet's car 10 (VIBE_CITY_DESTRUCTIBLE_VEHICLES order in native-mac.sh). */
const TRUCK = 10;
const round = (v, d = 2) => +v.toFixed(d);

function probe(ctx, t, seen) {
  let d;
  try { d = JSON.parse(ctx.session.vehicleDebug(TRUCK)); } catch (error) { ctx.log(`probe ${t}: ${error?.message ?? error}`); return; }
  const v2 = d.vehicle2 ?? {};
  const p = v2.position ?? [0, 0, 0];
  const broken = (d.bonds ?? []).filter((b) => b.remainingArea <= 0 || b.verdictBroken);
  const fresh = broken.filter((b) => !seen.has(b.index));
  for (const b of fresh) seen.add(b.index);
  const off = new Set((d.hulls ?? []).filter((h) => h.actor !== 0).map((h) => h.part));
  const meteors = (ctx.e2e.meteors?.() ?? []).filter((m) => m.position)
    .map((m) => round(Math.hypot(m.position[0] - p[0], m.position[1] - p[1], m.position[2] - p[2]), 1)).sort((a, b) => a - b);
  ctx.log(`probe ${JSON.stringify({
    t: round(t), x: round(p[0]), y: round(p[1], 3), z: round(p[2]), v: (v2.linearVelocity ?? []).map((c) => round(c, 1)),
    jounce: (v2.wheelJounce ?? []).map((j) => (j == null ? null : round(j, 3))), onRoad: v2.wheelsOnRoad,
    wheelMask: d.vehicle?.wheelMask, broken: broken.length, partsOff: off.size,
    fresh: fresh.slice(0, 12).map((b) => [b.index, b.a, b.b]), meteors: meteors.slice(0, 3),
    loads: (d.wheelLoads ?? []).map((w) => round(Math.hypot(...(w.suspension ?? [0, 0, 0])) / 1000, 1)),
  })}`);
}

shoot({ scene: 'town' }, ({ place }) => {
  const shots = chaseShots(place, { trace: false });
  const seen = new Set();
  // 0.05 s probes through the chase and the hit (shots 2 and 3), t from the chase's start.
  let from = 0;
  for (const shot of shots.slice(1)) {
    const at = from;
    shot.cues = [...shot.cues, ...Array.from({ length: Math.floor(shot.duration / 0.05) }, (_, k) => [k * 0.05, (ctx) => probe(ctx, at + k * 0.05, seen)])];
    from += shot.duration;
  }
  return shots;
});
