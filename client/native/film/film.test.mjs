// node --test client/native/film: the film toolkit's camera maths, places and
// timeline, without the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { catmullRom, easeProgress, posePath } from './spline.mjs';
import { placeResolver, point, offset } from './places.mjs';
import { hold, path, orbit, fire, timeline, cameraProblems, sightBlocked } from './shots.mjs';

const close = (a, b, eps = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) < eps);

test('the spline passes through every keyframe', () => {
  const points = [[0, 0, 0], [10, 5, 0], [20, 0, 10], [30, 2, 10]];
  const curve = catmullRom(points);
  points.forEach((p, i) => assert.ok(close(curve(i), p), `keyframe ${i}: ${curve(i)}`));
});

test('ease: 0 to 1, monotonic, flat at eased ends, even in the middle', () => {
  for (const ease of ['both', 'in', 'out', 'none']) {
    assert.equal(easeProgress(0, ease), 0);
    assert.ok(Math.abs(easeProgress(1, ease) - 1) < 1e-12, ease);
    let prev = 0;
    for (let u = 0.01; u <= 1; u += 0.01) { const s = easeProgress(u, ease); assert.ok(s >= prev - 1e-12, `${ease} at ${u}`); prev = s; }
  }
  const speed = (u, ease) => (easeProgress(u + 1e-4, ease) - easeProgress(u - 1e-4, ease)) / 2e-4;
  assert.ok(speed(0.0002, 'both') < 0.01 && speed(0.9998, 'both') < 0.01);
  assert.ok(Math.abs(speed(0.4, 'both') - speed(0.6, 'both')) < 1e-6);
  // No jump in speed where a ramp meets the middle.
  assert.ok(Math.abs(speed(0.25 - 1e-3, 'both') - speed(0.25 + 1e-3, 'both')) < 0.02);
});

test('a path moves at an even speed through its keyframes', () => {
  const poses = [[0, 0], [50, 0], [60, 40], [200, 40]].map(([x, z]) => ({ position: [x, 3, z], lookAt: [x + 10, 2, z] }));
  const curve = posePath(poses);
  const steps = [];
  for (let k = 1; k <= 100; k += 1) steps.push(Math.hypot(...curve(k / 100).position.map((v, i) => v - curve((k - 1) / 100).position[i])));
  const mean = steps.reduce((a, b) => a + b) / steps.length;
  for (const d of steps) assert.ok(Math.abs(d - mean) / mean < 0.08, `step ${d} vs mean ${mean}`);
  assert.ok(close(curve(0).position, poses[0].position) && close(curve(1).position, poses[3].position, 1e-3));
});

test('a pan in place still moves', () => {
  const curve = posePath([{ position: [0, 5, 0], lookAt: [10, 0, 0] }, { position: [0, 5, 0], lookAt: [0, 0, 10] }]);
  assert.ok(close(curve(0.5).position, [0, 5, 0]));
  assert.ok(!close(curve(0.5).lookAt, curve(0).lookAt, 0.5));
});

const PLACES = [
  { id: 'elm-park/house-1', kind: 'house', district: 'elm-park', position: [-50, 0, 16], top: 8 },
  { id: 'elm-park/house-2', kind: 'house', district: 'elm-park', position: [-34, 0, 16], top: 5 },
  { id: 'car-0', kind: 'car', position: [-26, 0, 35], heading: 0 },
  { id: 'elm-park', kind: 'district', position: [-75, 0, 0] },
];

test('places by id, by kind and nearest, and as points', () => {
  const place = placeResolver(PLACES);
  assert.equal(place('car-0').id, 'car-0');
  assert.equal(place('house-2').id, 'elm-park/house-2');
  assert.equal(place('house', { nearest: [-51, 15] }).id, 'elm-park/house-1');
  assert.throws(() => place('house'), /names 2 places/);
  assert.throws(() => place('tower'), /no place 'tower'/);
  assert.deepEqual(point('elm-park/house-1', place), [-50, 4, 16]);
  assert.deepEqual(point(place('car-0'), place), [-26, 0.9, 35]);
  assert.deepEqual(point(offset('car-0', [1, 1, -6]), place), [-25, 1.9, 29]);
});

test('a timeline: shots end to end, cues in order', () => {
  const place = placeResolver(PLACES);
  const calls = [];
  const ctx = {
    place, log: (m) => calls.push(['log', m]),
    e2e: { setShotMode: (m) => calls.push(['mode', m]), dropAt: (p) => calls.push(['drop', p]), snapshot: () => ({ position: [0, 0, 0], city: { brokenBonds: 0 } }) },
    drive: { lookAt: (...p) => calls.push(['look', p]), fire: () => calls.push(['fire']) },
  };
  const a = { position: [0, 10, 0], lookAt: 'elm-park' };
  const tl = timeline([
    hold(a, 2),
    path([a, { position: [10, 10, 0], lookAt: 'car-0' }], 4, { cues: [[1, fire({ from: [-50, 1, 0], at: 'house-1', shots: 3, every: 0.5 })]] }),
    orbit({ centre: 'car-0', radius: 5, height: 2, from: 0, to: 90 }, 3),
  ]).build(ctx);
  assert.equal(tl.duration, 9);
  assert.equal(tl.shotAt(1.9), 0);
  assert.equal(tl.shotAt(2), 1);
  assert.equal(tl.shotAt(99), 2);
  assert.ok(close(tl.poseAt(6).position, [-26, 2, 40]));
  assert.ok(close(tl.poseAt(9).position, [-21, 2, 35]));
  for (const cue of tl.cues) cue.run(ctx);
  assert.deepEqual(tl.cues.map((c) => +c.time.toFixed(2)), [3, 3.6, 3.7, 4.1, 4.2, 4.6, 4.7, 6.1]);
  assert.deepEqual(calls.slice(0, 2), [['mode', 'cannonball'], ['drop', { position: [-50, 1, 0], yaw: 0, pitch: 0 }]]);
  // Three rounds spread side to side across the house, alternately low and high.
  const looks = calls.filter((c) => c[0] === 'look').map((c) => c[1]);
  assert.deepEqual(looks.map((p) => p[0]), [-51.6, -50, -48.4]);
  assert.deepEqual(looks.map((p) => p[1]), [3, 5, 3]);
  assert.equal(calls.filter((c) => c[0] === 'fire').length, 3);
});

test('camera problems: under the street, inside a building', () => {
  const place = placeResolver([{ id: 'house-1', kind: 'house', position: [0, 0, 0], min: [-5, 0, -5], max: [5, 8, 5], top: 8 }]);
  const tl = timeline([
    path([{ position: [-20, 3, 0], lookAt: [0, 0, 0] }, { position: [20, 3, 0], lookAt: [30, 0, 0] }], 4, { name: 'through' }),
    path([{ position: [-20, 3, 20], lookAt: [0, 0, 0] }, { position: [20, 0.5, 20], lookAt: [0, 0, 0] }], 4, { name: 'down' }),
    hold({ position: [0, 20, 0], lookAt: 'house-1' }, 1, { name: 'clear' }),
  ]).build({ place });
  const problems = cameraProblems(tl, place.all).filter((p) => !/view is/.test(p));
  assert.equal(problems.length, 2, problems.join('; '));
  assert.match(problems[0], /through's camera is inside house-1/);
  assert.match(problems[1], /down's camera is 0\.\d m high/);
});

test('sight lines: a tree in front of the subject blocks it, the subject itself does not', () => {
  const house = { id: 'house-1', kind: 'house', min: [-5, 0, -5], max: [5, 8, 5] };
  const tree = { id: 'tree-1', kind: 'tree', min: [-14, 0, -3], max: [-10, 9, 3] };
  const pose = { position: [-30, 4, 0], lookAt: [0, 4, 0] };
  const seen = sightBlocked(pose, [house, tree]);
  assert.ok(seen.fraction >= 0.6, String(seen.fraction));
  assert.deepEqual(seen.by, ['tree-1']);
  assert.equal(sightBlocked({ position: [0, 4, 30], lookAt: [0, 4, 0] }, [house, tree]).fraction, 0);
  const place = placeResolver([{ ...house, position: [0, 0, 0], top: 8 }, { ...tree, position: [-12, 0, 0], top: 9 }]);
  const tl = timeline([hold(pose, 2, { name: 'leaves' })]).build({ place });
  assert.match(cameraProblems(tl, place.all).join('; '), /leaves's view is \d+% blocked \(tree-1\)/);
});

// The scene's real places, when it has been built (structures/vibe-town/build-town.mjs).
const META = new URL('../../../structures/vibe-town/out/vibe-town.meta.json', import.meta.url);
test('Vibe Town names its houses, cars and streets', { skip: !existsSync(META) }, () => {
  const place = placeResolver(JSON.parse(readFileSync(META, 'utf8')).places);
  assert.equal(place.all.filter((p) => p.kind === 'house').length, 42);
  assert.equal(place('car', { nearest: [-26, 35] }).id, 'car-5');
  assert.equal(place('house', { nearest: [-51, 16] }).id, 'elm-park/house-26');
  assert.equal(place('street/north-street').position[2], 48);
});
