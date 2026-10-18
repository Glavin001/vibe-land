// The judge on synthetic reports (no GPU): node --test structures/calibration/tests/judge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/judge.mjs';

// A chain anchor - a - b - c - anchor (nodes 0..4), bonds 0-1, 1-2, 2-3, 3-4.
const spec = (state, over = []) => ({
  criteria: { holdsMaxDrop: 0.02, collapseMinDrop: 1.0 }, band: 0.15,
  cases: [{ id: 'x', label: 'x', nodes: [0, 5], bonds: [0, 4], offset: [0, 0, 0], names: ['A', 'a', 'b', 'c', 'B'], anchors: [0, 4],
    bondNodes: [[0, 1], [1, 2], [2, 3], [3, 4]], bondKeys: ['k0', 'k1', 'k2', 'k3'],
    predictions: { real: { state, u: over[0]?.u ?? 0.5, worst: over[0]?.key ?? 'k1', over, bonds: { k0: 0.5, k1: 0.5, k2: 0.5, k3: 0.5 } } } }],
});
const report = ({ broken = [], drop = 0 }) => ({
  positions: [{ tick: 0, p: [0, 5, 0, 1, 5, 0, 2, 5, 0, 3, 5, 0, 4, 5, 0] }, { tick: 600, p: [0, 5, 0, 1, 5 - drop, 0, 2, 5 - drop, 0, 3, 5 - drop, 0, 4, 5, 0] }],
  cases: { x: { broken: broken.map(([a, b, tick]) => ({ tick, detail: { at: { node0: a, node1: b, utilisation: 0 }, before: null } })) } },
  rows: [], unconvergedTicks: 0, errors: {},
});

test('holds: nothing broke, nothing moved', () => {
  const v = judge(spec('holds'), report({}), 'section', 'real');
  assert.equal(v.cases[0].measured.state, 'holds');
  assert.ok(v.passed);
});

test('collapses: it fell, and it started at a bond past capacity', () => {
  const s = spec('collapses', [{ key: 'k1', u: 1.6 }, { key: 'k2', u: 1.3 }]);
  const v = judge(s, report({ broken: [[1, 2, 1], [2, 3, 1]], drop: 5 }), 'section', 'real');
  assert.equal(v.cases[0].measured.state, 'collapses');
  assert.ok(v.cases[0].ok.state && v.cases[0].ok.members);
});

test('fractured: free of every anchor but jammed in place counts as the predicted failure, not as a fall', () => {
  const s = spec('collapses', [{ key: 'k1', u: 1.6 }]);
  const v = judge(s, report({ broken: [[0, 1, 1], [3, 4, 1], [1, 2, 1]], drop: 0.003 }), 'section', 'real');
  assert.equal(v.cases[0].measured.state, 'fractured');
  assert.ok(v.cases[0].ok.state);
  assert.equal(v.cases[0].ok.fell, false);
});

test('a miss: predicted to hold, it broke', () => {
  const v = judge(spec('holds'), report({ broken: [[1, 2, 3]], drop: 0 }), 'section', 'real');
  assert.equal(v.cases[0].measured.state, 'damaged');
  assert.equal(v.passed, false);
});
