#!/usr/bin/env node
// Every town-kit building variant and street fixture Vibe Town could use, one
// of each, 40 m apart, each its own structure (`kind@name`), so
// scripts/perf/qualify_structures.py can say which converge and stand at rest:
//
//   node structures/vibe-town/candidates.mjs            -> out/vibe-town-candidates.json
//   python3 scripts/perf/qualify_structures.py structures/vibe-town/out/vibe-town-candidates.json
//
// Vibe Town (build-town.mjs) uses only the ones that pass. `--sweep` instead
// builds the props that fall apart at rest (trees, bus shelter, market stall)
// at several bond-strength factors (strengthen.mjs), to find the smallest that
// stands: out/vibe-town-sweep.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBungalow, buildPorchHouse, buildStripShop, buildCornerGrocery, buildVictorianCorner, buildWorkshop,
  buildNeighborhoodLibrary, buildArtDecoCinema, buildFireStation, buildOutdoorProp, buildTree, composeScene,
} from '../town-kit/src/index.mjs';
import { strengthen } from './strengthen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** [name, () => asset]; unfurnished variants are lighter (fewer chunks). */
export const CANDIDATES = [
  ['bungalow', () => buildBungalow({ furnished: false })],
  ['bungalow-furnished', () => buildBungalow()],
  ['bungalow-nofence', () => buildBungalow({ furnished: false, fence: false })],
  ['porch-house', () => buildPorchHouse({ furnished: false })],
  ['porch-house-nofence', () => buildPorchHouse({ furnished: false, fence: false })],
  ['strip-shop', () => buildStripShop({ furnished: false })],
  ['strip-shop-cafe', () => buildStripShop({ signText: 'CAFE' })],
  ['corner-grocery', () => buildCornerGrocery({ furnished: false })],
  ['victorian-2f', () => buildVictorianCorner({ storeys: 2, furnished: false })],
  ['victorian-3f', () => buildVictorianCorner({ storeys: 3, furnished: false })],
  ['workshop', () => buildWorkshop({ furnished: false })],
  ['library', () => buildNeighborhoodLibrary({ furnished: false })],
  ['cinema', () => buildArtDecoCinema({ furnished: false })],
  ['fire-station', () => buildFireStation({ furnished: false })],
  ...['bus-shelter', 'carport', 'market-stall', 'scaffold', 'billboard', 'streetlight', 'street-sign',
    'bike-rack', 'hydrant', 'mailbox', 'low-wall', 'bollard'].map((type) => [type, () => buildOutdoorProp(type)]),
  ...['shade', 'street', 'conifer', 'ornamental', 'sapling'].flatMap((family) =>
    [0, 1, 2].map((variant) => [`tree-${family}-${variant}`, () => buildTree({ family, variant })])),
];

/** Props that fall apart at rest, at each bond-strength factor. */
export const SWEEP_FACTORS = [3, 10, 30, 100, 300];
export const SWEEP = [
  ...['shade', 'street', 'ornamental', 'conifer', 'sapling'].map((family) => [`tree-${family}`, () => buildTree({ family, variant: 0 })]),
  ['bus-shelter', () => buildOutdoorProp('bus-shelter')],
  ['market-stall', () => buildOutdoorProp('market-stall')],
].flatMap(([name, build]) => SWEEP_FACTORS.map((factor) => [`${name}-x${factor}`, () => strengthen(build(), factor)]));

export function buildCandidates(list = CANDIDATES) {
  const columns = 8;
  const placements = list.map(([name, build], i) => ({
    ...build(),
    position: [(i % columns) * 40, 0, Math.floor(i / columns) * 40],
    group: `candidate@${name}`,
  }));
  return composeScene(placements, { key: 'vibe-town-candidates' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sweep = process.argv.includes('--sweep');
  const list = sweep ? SWEEP : CANDIDATES;
  const file = sweep ? 'vibe-town-sweep.json' : 'vibe-town-candidates.json';
  const pack = buildCandidates(list);
  mkdirSync(path.join(here, 'out'), { recursive: true });
  writeFileSync(path.join(here, 'out', file), JSON.stringify(pack));
  console.log(`${list.length} candidates, ${pack.scenario.nodes.length} nodes -> structures/vibe-town/out/${file}`);
}
