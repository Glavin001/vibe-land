import { FOLIAGE_PROFILES, FOLIAGE_SPECIES } from './foliageProfiles';
import { Box3, Quaternion, Vector3 } from 'three';
import type { CityManifest } from '../../city/manifest';
import { cityGrassPaint, GRASS_MAX_HEIGHT, type GrassPaint } from './GrassPaint';

export const GRASS_PATCH_SIZE = 8;
export const GRASS_WORLD_HALF_EXTENT = 256;
export type GrassQuality = 'fast' | 'pretty';
export type GrassExclusion = { minX: number; minZ: number; maxX: number; maxZ: number };
export const GRASS_PROFILES = {
  fast: { density: 30, distance: 28, near: 9, middle: 18 },
  pretty: { density: 150, distance: 48, near: 16, middle: 30 },
} as const;

function randomFor(x: number, z: number): () => number {
  let seed = Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ 0x65a73e91;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Conservative original footprints, including rotation, balconies and a 0.65 m verge.
 * Deliberately remain bare after demolition. No physics or live body queries. */
export function grassExclusionsFromManifest(manifest: CityManifest): GrassExclusion[] {
  const point = new Vector3();
  const rotation = new Quaternion();
  const bounds = new Box3();
  const result: GrassExclusion[] = [];
  for (const structure of manifest.structures) {
    bounds.makeEmpty();
    rotation.fromArray(structure.worldRotation).normalize();
    for (const chunk of structure.chunks) {
      for (let corner = 0; corner < 8; corner++) {
        point.set(
          chunk.centroid[0] + (corner & 1 ? 0.5 : -0.5) * chunk.size[0],
          chunk.centroid[1] + (corner & 2 ? 0.5 : -0.5) * chunk.size[1],
          chunk.centroid[2] + (corner & 4 ? 0.5 : -0.5) * chunk.size[2],
        ).applyQuaternion(rotation);
        point.x += structure.worldPosition[0];
        point.y += structure.worldPosition[1];
        point.z += structure.worldPosition[2];
        bounds.expandByPoint(point);
      }
    }
    if (!bounds.isEmpty()) result.push({
      minX: bounds.min.x - 0.65, minZ: bounds.min.z - 0.65,
      maxX: bounds.max.x + 0.65, maxZ: bounds.max.z + 0.65,
    });
  }
  return result;
}

/** Minimum 3D distance to a flat patch, so aerial views don't draw invisible blades. */
export function grassPatchDistance(x: number, y: number, z: number, px: number, pz: number): number {
  const dx = Math.max(px * GRASS_PATCH_SIZE - x, 0, x - (px + 1) * GRASS_PATCH_SIZE);
  const dz = Math.max(pz * GRASS_PATCH_SIZE - z, 0, z - (pz + 1) * GRASS_PATCH_SIZE);
  return Math.hypot(dx, Math.max(0, y - 0.8), dz);
}

export function grassDensityAtDistance(distance: number, quality: GrassQuality): number {
  const p = GRASS_PROFILES[quality];
  const smooth = (a: number, b: number) => {
    const t = Math.max(0, Math.min(1, (distance - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return (1 - 0.55 * smooth(p.near * 0.5, p.near))
    * (1 - 0.65 * smooth(p.middle * 0.65, p.middle));
}

export interface GrassPatchData {
  /** local x, local z, height, azimuth */
  roots: Float32Array;
  /** width, lean, variation, density rank */
  shapes: Uint16Array;
  colors: Uint8Array;
  /** Health, dryness, stiffness, stable species ID; normalized bytes. */
  traits: Uint8Array;
  maxHeight: number;
  count: number;
}

/** Random order is intentional: every instanceCount prefix covers the WHOLE patch.
 * Positions and appearance are stable when leaving, returning or changing LOD. */
export function generateGrassPatch(px: number, pz: number, quality: GrassQuality, exclusions: readonly GrassExclusion[], paint: GrassPaint = cityGrassPaint): GrassPatchData {
  const count = Math.round(GRASS_PROFILES[quality].density * GRASS_PATCH_SIZE ** 2);
  const roots = new Float32Array(count * 4);
  // Normalized 16-bit attributes: widths retain ~0.015 mm precision and save
  // 25% of resident instance memory versus two float vec4s.
  const shapes = new Uint16Array(count * 4);
  const colors = new Uint8Array(count * 3);
  const traits = new Uint8Array(count * 4);
  const samplePaint = paint.sampler(px, pz), style: number[] = [];
  const random = randomFor(px, pz);
  const ox = px * GRASS_PATCH_SIZE;
  const oz = pz * GRASS_PATCH_SIZE;
  const nearby = exclusions.filter(b => b.maxX >= ox && b.minX <= ox + GRASS_PATCH_SIZE
    && b.maxZ >= oz && b.minZ <= oz + GRASS_PATCH_SIZE);
  let accepted = 0;
  let maxHeight = 0;
  for (let i = 0; i < count; i++) {
    const x = random() * GRASS_PATCH_SIZE;
    const z = random() * GRASS_PATCH_SIZE;
    const wx = ox + x;
    const wz = oz + z;
    const variation = random();
    const height = random();
    const yaw = random() * Math.PI * 2;
    const lean = random();
    const coverage = random();
    if (Math.abs(wx) >= GRASS_WORLD_HALF_EXTENT || Math.abs(wz) >= GRASS_WORLD_HALF_EXTENT) continue;
    if (nearby.some(b => wx >= b.minX && wx <= b.maxX && wz >= b.minZ && wz <= b.maxZ)) continue;
    samplePaint(x, z, style);
    const speciesId = Math.round(style[5]*255);
    const species = FOLIAGE_SPECIES[speciesId] ?? 'grass';
    const profile = FOLIAGE_PROFILES[species];
    const densityScale = Math.min(1, profile.density/GRASS_PROFILES[quality].density);
    if (coverage >= style[0]*densityScale) continue;
    const spacing = style[9]*4;
    if (spacing > 0.1) {
      const angle = style[10]*Math.PI*2;
      const across = wx*Math.cos(angle)-wz*Math.sin(angle);
      const toRow = Math.abs(across/spacing-Math.round(across/spacing))*spacing;
      if (toRow > spacing*0.3) continue;
    }
    // Broad growth variation, with smaller clumps; never a repeating blade grid.
    const fertility = 0.5 + 0.25 * Math.sin(wx * 0.23 + Math.sin(wz * 0.31))
      + 0.25 * Math.sin(wz * 0.49 + wx * 0.17);
    if (variation < 0.08 * (1 - fertility)) continue;
    const authoredHeight = style[1] * GRASS_MAX_HEIGHT;
    const tallness = Math.max(0, Math.min(1, (authoredHeight-1.25)/1.25));
    // Tall stands need a high canopy, not mostly ankle-height blades with a few giants.
    const minimumHeight = 0.35 + tallness * 0.45;
    const bladeHeight = (0.45+style[8]*0.55) * (minimumHeight + height * (1-minimumHeight)) * authoredHeight * (0.8 + fertility * 0.2);
    maxHeight = Math.max(maxHeight, bladeHeight);
    colors.set([style[2]*255, style[3]*255, style[4]*255], accepted*3);
    traits.set([style[6]*255, style[7]*255, (style[11]*0.5+profile.stiffness*0.5)*255, speciesId], accepted*4);
    const j = accepted++ * 4;
    roots.set([x, z, bladeHeight, yaw], j);
    shapes.set([(0.009 + variation * 0.015) * (1 + tallness*2) * profile.width * (0.7+style[6]*0.3) * 65535, (0.18 + lean * 0.6) * (1-tallness*0.65) * 65535, variation * 65535, 0], j);
  }
  // Rank tracks accepted indices, so culling exclusions never biases the LOD.
  for (let i = 0; i < accepted; i++) shapes[i * 4 + 3] = Math.floor(i / accepted * 65535);
  return { roots: roots.slice(0, accepted * 4), shapes: shapes.slice(0, accepted * 4), colors: colors.slice(0, accepted*3), traits: traits.slice(0, accepted*4), maxHeight, count: accepted };
}
