// Catalog of color-grading LUTs shipped under client/public/assets/postfx/.
// See CREDITS.md for licensing.
//
// Consumers wire these into a postprocessing `LUTPass` (from `postprocessing`)
// or an equivalent Three.js shader pass. .CUBE/.3dl files are parsed with a
// LUT loader (e.g. three/examples/jsm/loaders/LUT3dlLoader or LUTCubeLoader).

export type LutFormat = 'cube' | '3dl' | 'png';

export interface LutPreset {
  id: string;
  label: string;
  path: string;
  format: LutFormat;
}

const BASE = '/assets/postfx';

export const LUT_PRESETS: LutPreset[] = [
  { id: 'neutral', label: 'Neutral (Identity)', path: `${BASE}/NeutralLUT.png`, format: 'png' },
  { id: 'night', label: 'Night', path: `${BASE}/NightLUT.png`, format: 'png' },
  { id: 'bw', label: 'Black & White', path: `${BASE}/B&WLUT.png`, format: 'png' },
  { id: 'bourbon_64', label: 'Bourbon 64', path: `${BASE}/Bourbon 64.CUBE`, format: 'cube' },
  { id: 'chemical_168', label: 'Chemical 168', path: `${BASE}/Chemical 168.CUBE`, format: 'cube' },
  { id: 'clayton_33', label: 'Clayton 33', path: `${BASE}/Clayton 33.CUBE`, format: 'cube' },
  { id: 'cubicle_99', label: 'Cubicle 99', path: `${BASE}/Cubicle 99.CUBE`, format: 'cube' },
  { id: 'remy_24', label: 'Remy 24', path: `${BASE}/Remy 24.CUBE`, format: 'cube' },
  { id: 'presetpro_cinematic', label: 'Presetpro Cinematic', path: `${BASE}/Presetpro-Cinematic.3dl`, format: '3dl' },
  { id: 'generic_lut', label: 'Generic LUT', path: `${BASE}/lut.3dl`, format: '3dl' },
  { id: 'generic_lut_v2', label: 'Generic LUT v2', path: `${BASE}/lut_v2.3dl`, format: '3dl' },
];

export function getLutPreset(id: string): LutPreset | undefined {
  return LUT_PRESETS.find((preset) => preset.id === id);
}
