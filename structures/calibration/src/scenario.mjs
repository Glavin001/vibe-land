/**
 * A calibration scenario as data: its cases (each a structure, the members
 * removed, the hand calculation's prediction per engine configuration) laid
 * out side by side in one scene, and the spec the judge holds a run to.
 *
 * A scenario module exports:
 *   id, title, ticks           the run (10 s at 60 Hz unless it needs longer)
 *   spacing                    metres between cases along z
 *   cases()                    [{id, label, pack, bonds: [{member, ...key}], names,
 *                                predictions: {<model>: {state, u, worst, over: [keys]}}, notes}]
 *   models                     {<config>: <prediction model>} -- which prediction each engine
 *                              configuration is held to (see configs.mjs)
 *
 * The written spec (out/<id>/spec.json) is everything a judge or a perf suite
 * needs without the builders: the scene path, each case's node and bond
 * ranges in the scene, every bond's key, the predictions and the criteria.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases as compose } from './pack.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(ROOT, '../..');
export const OUT = path.join(ROOT, 'out');

/**
 * Outcome thresholds. A rigid-chunk structure does not deflect: a chunk that
 * has moved has broken free. `holds`: no bond broken and nothing displaced by
 * more than 2 cm (contact settling). `collapses`: some chunk of the structure
 * dropped by more than 1 m. Anything between is `damaged` (bonds broke, it
 * stands).
 */
export const CRITERIA = { holdsMaxDrop: 0.02, collapseMinDrop: 1.0 };

/**
 * A prediction's state from its utilisation, with the band the scenario
 * justifies: holds below 1 - band, collapses above 1 + band, either between.
 */
export const stateOf = (u, band) => (u < 1 - band ? 'holds' : u > 1 + band ? 'collapses' : 'either');

export function writeScenario(scenario) {
  const dir = path.join(OUT, scenario.id);
  mkdirSync(dir, { recursive: true });
  const list = scenario.cases();
  const placed = list.map((c, k) => ({ id: c.id, pack: c.pack, position: [0, 0, k * scenario.spacing] }));
  const scene = compose(placed, { key: `calibration-${scenario.id}`, title: scenario.title });
  let node = 0, bond = 0;
  const specCases = list.map((c, k) => {
    const n = c.pack.scenario.nodes.length, b = c.pack.scenario.bonds.length;
    const out = {
      id: c.id, label: c.label, offset: [0, 0, k * scenario.spacing], nodes: [node, node + n], bonds: [bond, bond + b],
      names: c.names, bondKeys: c.bonds, bondNodes: c.pack.scenario.bonds.map((x) => [x.node0, x.node1]), anchors: c.pack.scenario.nodes.map((x, i) => (x.mass === 0 ? i : -1)).filter((i) => i >= 0),
      types: c.pack.scenario.nodeTypes, removed: c.removed ?? [], predictions: c.predictions, notes: c.notes ?? null,
    };
    node += n; bond += b;
    return out;
  });
  const scenePath = path.join(dir, 'scene.json');
  writeFileSync(scenePath, JSON.stringify(scene));
  const spec = { scenario: scenario.id, title: scenario.title, scene: scenePath, ticks: scenario.ticks ?? 600, criteria: { ...CRITERIA, ...(scenario.criteria ?? {}) },
    band: scenario.band, models: scenario.models, cases: specCases, hand: scenario.hand ?? null };
  writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
  return { dir, spec, scene };
}
