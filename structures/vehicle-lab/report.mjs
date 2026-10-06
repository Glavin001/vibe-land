#!/usr/bin/env node
// Judge a vehicle test bed report against criteria.mjs and print the table.
//
//   node structures/vehicle-lab/report.mjs target/vehicle-testbed/NAME.json [--report-only] [--baseline OTHER.json]
//
// Writes NAME-verdict.json beside the report: per car, per criterion, the
// measured value, the threshold, pass/fail and why the threshold is what it
// is. --baseline adds the baseline's value of each measurement beside it.
// Exit 1 when any criterion fails (unless --report-only).
import { readFileSync, writeFileSync } from 'node:fs';
import { judge } from './criteria.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--baseline');
const baselineFile = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : null;
if (!file) { console.error('usage: report.mjs REPORT.json [--report-only] [--baseline OTHER.json]'); process.exit(2); }
const report = JSON.parse(readFileSync(file, 'utf8'));
const baseline = baselineFile ? JSON.parse(readFileSync(baselineFile, 'utf8')) : null;
const meta = JSON.parse(readFileSync(new URL('./out/vehicle-lab.meta.json', import.meta.url), 'utf8'));
const verdict = judge(report, baseline, meta);

const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
let failed = 0;
for (const car of verdict.cars) {
  console.log(`\n${car.car} (${car.role}; ${car.mass.toFixed(0)} kg, ${car.bonds} bonds, ${car.parts} parts): ${car.passed}/${car.rows.length} criteria`);
  for (const row of car.rows) {
    if (!row.pass) failed += 1;
    const base = row.baseline != null ? `  (was ${row.baseline})` : '';
    console.log(`  ${row.pass ? 'PASS' : 'FAIL'}  ${pad(row.trial, 10)} ${pad(row.criterion, 44)} ${pad(row.value, 22)} ${pad(row.threshold, 16)}${base}`);
  }
}
const out = file.replace(/\.json$/, '-verdict.json');
writeFileSync(out, JSON.stringify(verdict, null, 1));
console.log(`\n${failed ? `${failed} criteria failed` : 'every criterion passed'}; verdict ${out}`);
if (failed && !args.includes('--report-only')) process.exit(1);
