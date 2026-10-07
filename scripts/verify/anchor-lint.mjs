#!/usr/bin/env node
// The town kit's anchor lint on every pack a profile builds: a fixed (mass 0)
// chunk standing above grade is a support that never breaks or crushes -- an
// infinite wall to anything that hits it (the meteor on a footing, 2026-10-07).
// With TOWN_KIT_BURIED_ANCHORS=1 in the profile a violation fails; otherwise the
// count is reported.
//   node scripts/verify/anchor-lint.mjs runtime|high
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { lintAnchors } = await import(path.join(root, 'structures/town-kit/src/geometry.mjs'));
const profile = process.argv[2] ?? 'runtime';
const env = execFileSync('bash', ['-c', `source scripts/fidelity/${profile === 'high' ? 'high' : 'runtime'}.env; echo $TOWN_KIT_BURIED_ANCHORS; scripts/fidelity/packs.sh ${profile}`], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const buried = env[0] === '1';
const packs = Object.fromEntries(env.slice(1).map((l) => l.split('=')));
let failed = 0;
for (const [key, p] of Object.entries(packs)) {
  const files = key === 'veneer' ? ['veneer-house.json', 'veneer-bungalow.json'].map((f) => path.join(p, f)) : [p];
  for (const f of files) {
    let pack;
    try { pack = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.log(`MISSING ${f}`); failed++; continue; }
    const bad = lintAnchors(pack);
    const groups = [...new Set(bad.map((b) => `${b.group.split('@')[0]}:${b.type}`))];
    const status = bad.length === 0 ? 'PASS' : buried ? 'FAIL' : 'REPORT';
    if (status === 'FAIL') failed++;
    console.log(`${status.padEnd(6)} ${path.basename(f)}: ${bad.length} fixed chunk(s) above grade${bad.length ? ` (${groups.slice(0, 6).join(', ')}${groups.length > 6 ? ' ...' : ''}; highest ${Math.max(...bad.map((b) => b.top))} m)` : ''}`);
  }
}
console.log(`anchor lint (${profile}, buried anchors ${buried ? 'on: violations fail' : 'off: reported'}): ${failed ? failed + ' failing' : 'ok'}`);
process.exitCode = failed ? 1 : 0;
