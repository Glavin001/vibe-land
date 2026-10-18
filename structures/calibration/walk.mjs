#!/usr/bin/env node
/**
 * The walk test for the calibration frame's stair tower (frame-building.mjs
 * stairTower): the game's own player walks from the ground up the dogleg to
 * the first floor and into the building, and back down, on walking input only
 * (server/src/structure_qualification.rs route_walk: no point missed, no
 * teleport, no fall of more than one code riser, headroom >= 2032 mm, no bond
 * broken), on the GPU stage under the app's stress settings.
 *
 *   node structures/calibration/walk.mjs [--snap]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { binary } from './run.mjs';
import { SDKS } from './src/configs.mjs';
import { OUT, REPO } from './src/scenario.mjs';
import * as F from './src/frame-building.mjs';

const P = F.params('ordinary'), b = F.build(P, 'ordinary', []);
const x0 = F.columnsX(P).at(-1) + P.column / 2 + 0.01, gap = 0.06, width = 1.25, z0 = 1.0, run = 0.29, n = 10;
const lane1 = x0 + gap + width / 2, lane2 = x0 + 2 * gap + 1.5 * width, zH = z0 + n * run, L1 = P.storey, H = P.storey / 2;
const up = [
  { name: 'ground', at: [lane1, 0, 0.3] },
  { name: 'flight-foot', at: [lane1, 0, 0.85] },
  { name: 'half-landing', at: [lane1, H, zH + 0.4] },
  { name: 'half-landing-across', at: [lane2, H, zH + 0.4] },
  { name: 'floor-1-landing', at: [lane2, L1, 0.4] },
  { name: 'floor-1-edge', at: [x0 + 0.4, L1, 0.4] },
  { name: 'floor-1-inside', at: [16.5, L1, 0.6] },
];
const route = [...up, ...up.slice(0, -1).reverse().map((p) => ({ ...p, name: `down-${p.name}` }))];
const dir = path.join(OUT, 'walk'); mkdirSync(dir, { recursive: true });
const pack = path.join(dir, 'rc-frame.json'), meta = path.join(dir, 'rc-frame.meta.json');
writeFileSync(pack, JSON.stringify(b.pack)); writeFileSync(meta, JSON.stringify({ route }, null, 1));
const exe = binary(SDKS.roof);
const env = { ...process.env, PHYSX_ROOT: SDKS.roof, VIBE_CITY_SCENE: pack, VIBE_WALK_META: meta, VIBE_CITY_GRID: '1', VIBE_CITY_VARIED_HEIGHTS: '0', VIBE_CITY_VEHICLES: '0',
  VIBE_QUALIFY_REST_TICKS: '180', VIBE_GPU_SHARED: '1', VIBE_NATIVE_STRESS_FORCE_TOLERANCE: '0.001', BLAST_STRESS_INCREMENTAL_MOTION: '1', PX_DESTRUCTION_INCREMENTAL_TOPOLOGY: '1', BLAST_STRESS_BALANCED_OPERATOR: '1',
  VIBE_DESTRUCTION_ASSET_DIR: path.join(REPO, 'destruction/assets/scenes'), CUMETAL_CACHE_DIR: path.join(REPO, 'target', 'cumetal-cache-calib'),
  ...(process.argv.includes('--snap') && { VIBE_PLAYER_SNAP_TO_GROUND: '1' }) };
const r = spawnSync(path.join(REPO, 'scripts/perf/gpu-run.sh'), ['calib-walk', exe, 'route_walk', '--ignored', '--nocapture', '--test-threads=1'], { cwd: path.join(REPO, 'server'), env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1500e3 });
const text = `${r.stdout}\n${r.stderr}`, m = text.match(/route walk: (\{.*\})/);
writeFileSync(path.join(dir, 'walk.log'), text);
if (m) { const s = JSON.parse(m[1]); console.log(`walk PASSED: ${s.points} points in ${s.seconds.toFixed(1)} s, least headroom ${s.leastHeadroom.toFixed(3)} m, largest fall ${s.largestFall.toFixed(3)} m`); writeFileSync(path.join(dir, 'walk.json'), JSON.stringify(s, null, 1)); }
else { console.log(`walk FAILED: ${(text.match(/panicked at [^\n]*\n([^\n]*)/) ?? [])[1] ?? 'see out/walk/walk.log'}`); process.exitCode = 1; }
