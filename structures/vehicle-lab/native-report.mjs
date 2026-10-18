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
// Drive-aways are logged after their trial's measurement.
for (const l of readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('measure-away {'))) {
  const a = JSON.parse(l.slice(l.indexOf('measure-away {') + 13));
  const run = runs.find((r) => r.trial === a.trial);
  if (run) run.driveAway = a.driveAway;
}
// The build's driving setup (what the server prepares it with), for the
// criteria that judge against its own tune.
const { garageBuilds } = await import('../../client/src/vehicles/builds.mjs');
const { resolveDrivingSetup } = await import('../../client/src/vehicles/configuration.mjs');
for (const run of runs) {
  const build = garageBuilds.find((b) => b.id === run.car);
  if (build && run.mass) run.driving = resolveDrivingSetup(build.configuration, run.mass);
}
const stamp = path.basename(log).replace(/\.log$/, '');
const out = path.join(here, '../../target/vehicle-testbed', `native-${stamp}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ label: `native-${stamp}`, harness: 'native', log, runs }, null, 1));
console.log(`${runs.length} trials measured -> ${out}`);
const judged = spawnSync(process.execPath, [path.join(here, 'report.mjs'), out, '--report-only'], { stdio: 'inherit' });
process.exit(judged.status ?? 1);
