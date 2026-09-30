// Run vehicle QA scenarios several times each and summarise: live physics is
// not deterministic (how a car breaks decides what rocks or tumbles), so one
// run passing proves little. Exit 1 if any run failed.
//
//   cd client && node e2e/vehicle-qa-suite.mjs [--repeat 3] [scenario ...]
//   (no scenarios: all of e2e/vehicle-scenarios.mjs)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scenarios } from './vehicle-scenarios.mjs';

const args = process.argv.slice(2);
const repeatAt = args.indexOf('--repeat');
const repeat = repeatAt >= 0 ? Number(args[repeatAt + 1]) : 3;
const names = args.filter((a, i) => !a.startsWith('--') && (repeatAt < 0 || i !== repeatAt + 1));
const run = names.length ? names : Object.keys(scenarios);
const summary = [];
for (const name of run) {
  for (let i = 1; i <= repeat; i++) {
    const out = resolve(`../target/vehicle-qa/${name}-run${i}`);
    const child = spawnSync(process.execPath, ['e2e/vehicle-qa.mjs', name, '--out', out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600_000 });
    let report = null;
    try { report = JSON.parse(readFileSync(`${out}/report.json`, 'utf8')); } catch {}
    const checks = report?.checks ?? [];
    summary.push({ name, run: i, pass: child.status === 0, checks });
    console.log(`${child.status === 0 ? 'PASS' : 'FAIL'} ${name} #${i}`);
    for (const c of checks) console.log(`   ${c.pass ? 'ok  ' : 'FAIL'} car ${c.car} ${c.check}: ${c.detail}`);
  }
}
console.log('\nsummary');
for (const name of run) {
  const runs = summary.filter((s) => s.name === name);
  console.log(`  ${name.padEnd(22)} ${runs.filter((r) => r.pass).length}/${runs.length} passed`);
}
process.exit(summary.every((s) => s.pass) ? 0 : 1);
