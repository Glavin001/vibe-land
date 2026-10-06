// A film's cameras checked offline, in a second, without the game or the GPU:
//
//   node client/native/film/lint.mjs client/native/films/trailer.mjs [--every 0.5] [--shot NAME]
//
// The same checks a run logs before it rolls (shots.mjs cameraProblems: a
// camera under the street or inside a building or tree, a view blocked by
// trees and buildings), plus each shot's blocked share sampled through it,
// so a camera move can be tried and re-tried before a take. Vehicles are
// where they are parked: tracking shots follow the parking spot, not the
// car, so judge those from a check run (FILM_CHECK=1 logs `sight` per shot).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { placeResolver, SCENE_META } from './places.mjs';
import { timeline, cameraProblems, sightBlocked } from './shots.mjs';

const args = process.argv.slice(2);
const film = args.find((a) => !a.startsWith('--'));
if (!film) { console.error('usage: node client/native/film/lint.mjs FILM.mjs [--every SECONDS]'); process.exit(2); }
const every = Number(args[args.indexOf('--every') + 1]) || 0.5;
// --shot NAME: that shot's samples one per line, with the pose and what blocks it.
const only = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;
const bundleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist-native');

let problems = 0;
globalThis.__FILM_LINT__ = (options, script) => {
  const scene = options.scene ?? 'town';
  const meta = SCENE_META[scene] ? JSON.parse(readFileSync(resolve(bundleDir, SCENE_META[scene]), 'utf8')) : { places: [] };
  const place = placeResolver(meta.places ?? []);
  const tl = timeline(script({ place })).build({ place });
  const boxes = place.all.filter((p) => p.min && p.max);
  console.log(`${film}: ${tl.shots.length} shots, ${tl.duration.toFixed(1)} s, ${boxes.length} solid places`);
  for (const s of tl.shots) {
    const row = [];
    for (let t = 0; t <= s.duration + 1e-9; t += every) {
      const pose = s.pose(Math.min(t, s.duration)), seen = sightBlocked(pose, boxes);
      if (s.name === only) console.log(`    ${t.toFixed(1)}s ${pose.position.map((v) => v.toFixed(1))} -> ${pose.lookAt.map((v) => v.toFixed(1))}  ${Math.round(seen.fraction * 100)}% ${seen.by.join(', ')}`);
      row.push(seen.fraction === 0 ? '.' : String(Math.min(9, Math.round(seen.fraction * 10))));
    }
    console.log(`  ${s.name.padEnd(24)} ${(s.start).toFixed(1).padStart(5)}s  ${row.join('')}`);
  }
  for (const p of cameraProblems(tl, place.all)) { problems += 1; console.log(`WARNING: ${p}`); }
  console.log(problems ? `${problems} problem(s)` : 'no problems');
};
await import(pathToFileURL(resolve(film)).href);
process.exitCode = problems ? 1 : 0;
