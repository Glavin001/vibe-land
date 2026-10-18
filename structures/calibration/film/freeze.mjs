#!/usr/bin/env node
/**
 * A calibration take's cut with its opening frame held: the film
 * (client/native/films/calibration.mjs, CALIB_FREEZE) logs
 * `freeze {"seconds", "captions": [{text, from, to}]}` -- the structure starts
 * to fail on its first tick, so the prediction is read over the first frame,
 * held, before anything moves. This pads the raw recording with that frame
 * (ffmpeg tpad), shifts the log's edit list by the same, adds the freeze's
 * captions, and cuts it with scripts/film/post.py. Without a freeze line it is
 * post.py alone. The freeze's `skip` seconds (default 0.1) are dropped from
 * the start first: the app's first frames or two draw the scene before its
 * stream has filled in (a grey sky, chunks missing).
 *
 *   node structures/calibration/film/freeze.mjs RAW.mp4 LOG OUT.mp4 [--fps 30]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const [raw, log, out] = process.argv.slice(2);
const fps = process.argv.includes('--fps') ? process.argv[process.argv.indexOf('--fps') + 1] : '30';
if (!raw || !log || !out) { console.error('usage: freeze.mjs RAW.mp4 LOG OUT.mp4 [--fps 30]'); process.exit(2); }

const lines = readFileSync(log, 'utf8').split('\n');
const freezeLine = lines.map((l) => l.match(/(?:^|[\s\]])freeze (\{.*\})\s*$/)).find(Boolean);
const freeze = freezeLine ? JSON.parse(freezeLine[1]) : null;
const F = freeze?.seconds ?? 0;
const skip = freeze ? freeze.skip ?? 0.1 : 0;
const shift = (e) => {
  for (const k of ['from', 'to', 'at']) if (typeof e[k] === 'number') e[k] = +Math.max(F, e[k] + F - skip).toFixed(3);
  return e;
};
const edits = [];
for (const l of lines) {
  const m = l.match(/(?:^|[\s\]])edit (\{.*\})\s*$/);
  if (m) edits.push(shift(JSON.parse(m[1])));
}
for (const c of freeze?.captions ?? []) edits.push({ type: 'title', style: 'caption', text: c.text, from: c.from, to: c.to });

const dir = mkdtempSync(path.join(tmpdir(), 'calib-film-freeze-'));
try {
  let video = raw;
  if (F > 0) {
    video = path.join(dir, 'padded.mp4');
    // (-ss, not a trim filter: tpad after trim pads nothing, ffmpeg 7.1)
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(skip), '-i', raw, '-vf', `tpad=start_duration=${F}:start_mode=clone`,
      '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', video], { stdio: 'inherit' });
  }
  const editLog = path.join(dir, 'edits.log');
  writeFileSync(editLog, `${edits.map((e) => `[film] edit ${JSON.stringify(e)}`).join('\n')}\n`);
  if (edits.length) execFileSync('python3', [path.join(REPO, 'scripts/film/post.py'), video, editLog, '--out', out, '--fps', fps], { stdio: 'inherit' });
  else execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-c', 'copy', out], { stdio: 'inherit' });
  console.log(`take: ${out} (${F ? `${F} s held, ` : ''}${edits.length} edits)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
