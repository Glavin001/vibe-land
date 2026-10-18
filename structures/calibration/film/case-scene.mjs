#!/usr/bin/env node
/**
 * Some cases of a calibration scenario, as their own scene pack, for the film
 * (reel.sh): their nodes and bonds (spec.json's ranges), in spec order, where
 * they stand in the scenario's scene, nothing else. One case alone: the app's
 * broken-bond count is that case's own.
 *
 *   node structures/calibration/film/case-scene.mjs <scenario dir> <case id[,case id...]> <out.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { withoutNodes } from '../src/pack.mjs';

const [dir, id, out] = process.argv.slice(2);
if (!dir || !id || !out) { console.error('usage: case-scene.mjs <scenario dir> <case id[,case id...]> <out.json>'); process.exit(2); }
const spec = JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8'));
const scene = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8'));
const ids = id.split(',');
const cases = ids.map((x) => spec.cases.find((c) => c.id === x) ?? (() => { console.error(`no case ${x} (cases: ${spec.cases.map((c) => c.id).join(', ')})`); process.exit(2); })());
const { pack } = withoutNodes(scene, (i) => !cases.some((c) => i >= c.nodes[0] && i < c.nodes[1]));
pack.key = `${scene.key}-${ids.join('-')}`;
pack.title = `${scene.title ?? scene.key}: ${cases.length === 1 ? cases[0].label : ids.join(', ')}`;
const want = cases.reduce((n, c) => n + c.bonds[1] - c.bonds[0], 0), nodes = cases.reduce((n, c) => n + c.nodes[1] - c.nodes[0], 0);
if (pack.scenario.bonds.length !== want) { console.error(`${id}: ${pack.scenario.bonds.length} bonds, spec says ${want}`); process.exit(1); }
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(pack));
console.log(`${id}: ${nodes} nodes, ${want} bonds -> ${out}`);
