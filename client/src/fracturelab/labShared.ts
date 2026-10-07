// Small pieces both Fracture Lab stages share. Only imported behind __WEBGPU__.

import { exteriorTextureKey } from '../city/fracture/materialClass';
import type { Specimen } from '../city/fracture/specimens';
import { cityTextureDetail, heroTilingEnabled } from '../app/renderQuality';
import { layerCodeForTextureKey } from '../scene/cityTextures';
import type { PackSpecimen } from './packSpecimen';

export const labTriplanar = () => ({ pbr: true, detail: cityTextureDetail(), hero: heroTilingEnabled() });

/** The city texture layer each piece's outer faces wear (photo-texture mode). */
export function layerCodes(specimen: Specimen): Array<{ layerCode: number }> {
  const keys = (specimen as Partial<PackSpecimen>).textureKeys;
  const fallback = layerCodeForTextureKey('concrete-wall') ?? 0;
  return specimen.pieces.map((piece, i) => ({
    layerCode: layerCodeForTextureKey(keys?.[i] ?? exteriorTextureKey(piece.cls)) ?? fallback,
  }));
}

/**
 * Where copy c of a specimen sits: a square grid, rows receding along -z.
 * (The stills tool's overview camera assumes the same layout.)
 */
export function copyOffset(c: number, copies: number, size: readonly number[]): [number, number, number] {
  const cols = Math.ceil(Math.sqrt(Math.max(1, copies)));
  const row = Math.floor(c / cols);
  const col = c % cols;
  const pitchX = size[0] * 1.4 + 0.6;
  const pitchZ = Math.max(size[2], 1) * 1.8 + 1.5;
  return [copies > 1 ? (col - (cols - 1) / 2) * pitchX : 0, 0, -row * pitchZ];
}
