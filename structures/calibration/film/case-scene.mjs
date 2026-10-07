#!/usr/bin/env node
/**
 * One case of a calibration scenario alone, as its own scene pack, for its
 * take in the film (reel.sh): the case's nodes and bonds (spec.json's ranges),
 * where they stand in the scenario's scene, nothing else -- so the app's
 * broken-bond count is that case's own.
 *
 *   node structures/calibration/film/case-scene.mjs <scenario dir> <case id> <out.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { withoutNodes } from '../src/pack.mjs';

const [dir, id, out] = process.argv.slice(2);
if (!dir || !id || !out) { console.error('usage: case-scene.mjs <scenario dir> <case id> <out.json>'); process.exit(2); }
const spec = JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const scene = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8'));
const c = spec.cases.find((x) => x.id === id);
if (!c) { console.error(`no case ${id} (cases: ${spec.cases.map((x) => x.id).join(', ')})`); process.exit(2); }
const [from, to] = c.nodes;
const { pack } = withoutNodes(scene, (i) => i < from || i >= to);
pack.key = `${scene.key}-${id}`;
pack.title = `${scene.title ?? scene.key}: ${c.label}`;
const want = c.bonds[1] - c.bonds[0];
if (pack.scenario.bonds.length !== want) { console.error(`case ${id}: ${pack.scenario.bonds.length} bonds, spec says ${want}`); process.exit(1); }
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(pack));
console.log(`${id}: ${to - from} nodes, ${want} bonds -> ${out}`);
