// Real-world grounding report for the prepared vehicle builds (src/vehicles/reality.mjs).
// node scripts/vehicle-reality.mjs [../target/vehicle-build-fixtures.json]
// Exit 1 when a value is outside its real range and not a declared concession.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { garageBuilds } from '../src/vehicles/builds.mjs';
import { auditBuild, auditJoints } from '../src/vehicles/reality.mjs';

const fixtures = JSON.parse(readFileSync(resolve(process.argv[2] ?? '../target/vehicle-build-fixtures.json'), 'utf8'));
const fmt = v => Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
const mark = { ok: '  ', concession: '~ ', finding: '✗ ' };
let findings = 0;
const print = (label, r) => {
  if (r.status === 'finding') findings++;
  const off = r.status === 'ok' ? '' : ` (${r.factor < 1 ? `${((1 - r.factor) * 100).toFixed(0)}% below` : `${((r.factor - 1) * 100).toFixed(0)}% above`})`;
  console.log(`${mark[r.status]}${label.padEnd(9)} ${r.metric.padEnd(20)} ${fmt(r.value).padStart(8)}  real ${fmt(r.range[0])}-${fmt(r.range[1])}${off}${r.status === 'concession' ? `  concession: ${r.note}` : ''}`);
};
for (const { name, metadataPath, driving } of fixtures) {
  const build = garageBuilds.find(b => b.id === name);
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  for (const r of auditBuild(name, build.configuration.model, metadata, driving)) print(name, r);
  console.log();
}
for (const r of auditJoints()) print('joints', r);
console.log(`\n${findings} finding(s): values outside real ranges without a declared concession (src/vehicles/reality.mjs)`);
process.exit(findings ? 1 : 0);
