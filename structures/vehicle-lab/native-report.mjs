#!/usr/bin/env node
// The app's vehicle test bed run (scripts/native-mac.sh vehicle-lab) as a
// report: its `measure {json}` log lines -> target/vehicle-testbed/native-<stamp>.json,
// judged by report.mjs against criteria.mjs.
//
//   node structures/vehicle-lab/native-report.mjs target/native-video/vehicle-lab-<stamp>.log
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = process.argv[2];
if (!log) { console.error('usage: native-report.mjs LOG'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const runs = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('measure {'))
  .map((l) => JSON.parse(l.slice(l.indexOf('measure {') + 8)));
if (!runs.length) { console.error(`no measurements in ${log}`); process.exit(1); }
const stamp = path.basename(log).replace(/\.log$/, '');
const out = path.join(here, '../../target/vehicle-testbed', `native-${stamp}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ label: `native-${stamp}`, harness: 'native', log, runs }, null, 1));
console.log(`${runs.length} trials measured -> ${out}`);
const judged = spawnSync(process.execPath, [path.join(here, 'report.mjs'), out, '--report-only'], { stdio: 'inherit' });
process.exit(judged.status ?? 1);
