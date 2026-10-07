// The marble worktop is a look, not a material change: to the solver a
// kitchen counter is exactly the oak-topped counter it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCounter} from '../src/index.mjs';

const VISUAL = new Set(['name', 'color', 'textureKey', 'roughness', 'metalness', 'opacity', 'matter']);
const solver = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => !VISUAL.has(k)));

for (const variant of ['plain', 'sink', 'hob']) {
  test(`${variant} counter: a marble top with the oak top's strength and joints`, () => {
    const out = buildCounter({variant});
    const pack = out.pack ?? out, table = pack.defaults.solver.materials, s = pack.scenario;
    const worktop = table.findIndex((m) => m.name === 'marble-countertop');
    const oak = table.find((m) => m.name === 'warm-oak');
    assert.ok(worktop >= 0, 'the table has the worktop');
    assert.deepEqual(solver(table[worktop]), solver(oak));
    const top = new Set(s.nodes.flatMap((n, i) => (n.m === worktop ? [i] : [])));
    assert.ok(top.size > 0, 'the counter wears it');
    // Where the top meets the timber carcass it is jointed like any other
    // furniture timber (geometry.mjs), not bonded as the carcass itself.
    const carcass = table.findIndex((m) => m.name === 'dark-joinery');
    const toCarcass = s.bonds.filter((b) => (top.has(b.node0) && s.nodes[b.node1].m === carcass) || (top.has(b.node1) && s.nodes[b.node0].m === carcass));
    assert.ok(toCarcass.length > 0);
    for (const b of toCarcass) assert.equal(table[b.m].name, 'furniture-joinery');
  });
}
