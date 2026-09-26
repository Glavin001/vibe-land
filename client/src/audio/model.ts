export type Vec3 = readonly [number, number, number];
export type AcousticMaterial = 'concrete' | 'stone' | 'metal' | 'sheet' | 'wood' | 'glass' | 'earth';
export const MATERIALS: readonly AcousticMaterial[] = ['concrete', 'stone', 'metal', 'sheet', 'wood', 'glass', 'earth'];
export type SoundKind = 'impact' | 'fracture' | 'collapse' | 'flyby' | 'shot';
export interface SoundEvent {
  id: string;
  kind: SoundKind;
  position: Vec3;
  material: AcousticMaterial;
  /** Perceptual intensity 0..1, authored from physical quantities upstream. */
  intensity: number;
  size: number;
  seed: number;
  atMs: number;
  /** Flybys: world-space velocity in metres/second. Position and atMs identify
   * the closest pass, so the renderer can move the source along this path. */
  velocity?: Vec3;
  /** Flybys: distance to the listener at the closest observed/authored pass. */
  missDistance?: number;
  protected?: boolean;
  occlusion?: number;
}
export interface ContinuousSound {
  id: string;
  kind: 'scrape' | 'roll' | 'air' | 'engine' | 'wind';
  position: Vec3;
  material: AcousticMaterial;
  intensity: number;
  speed: number;
  velocity?: Vec3;
  occlusion?: number;
}
export function acousticMaterial(name = '', metalness = 0): AcousticMaterial {
  const n = name.toLowerCase();
  if (/glass|window/.test(n)) return 'glass';
  if (/wood|timber|plank|bark|tree/.test(n)) return 'wood';
  if (/sheet|tin|mailbox|panel/.test(n)) return 'sheet';
  if (/metal|steel|iron|alumin|vehicle|car/.test(n) || metalness > .6) return 'metal';
  if (/soil|dirt|sand|grass|earth/.test(n)) return 'earth';
  if (/stone|rock|granite|marble/.test(n)) return 'stone';
  return 'concrete';
}
export const clamp = (n: number, lo = 0, hi = 1): number => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
export function physicalIntensity(impulse: number, mass = 20): number {
  if (!Number.isFinite(impulse) || !Number.isFinite(mass) || impulse <= 0 || mass <= 0) return 0;
  // The caller supplies an equivalent impulse for the kinetic energy lost.
  // Compress joules perceptually: a tonne stopping at 6 m/s should carry much
  // more weight than a loose chip, even though neither is moving exceptionally fast.
  const energy = impulse * impulse / (2 * mass);
  return clamp(1 - Math.exp(-Math.pow(energy / 2500, .35)), 0, .98);
}
export function seedRandom(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

/** Swept relative motion: detects a pass even if it crosses the listener
 * entirely between snapshots. Teleports/large gaps are rejected by callers. */
export function closestPass(a: Vec3, b: Vec3, listenerA: Vec3, listenerB: Vec3): { distance: number; fraction: number; position: Vec3 } {
  const x=a[0]-listenerA[0], y=a[1]-listenerA[1], z=a[2]-listenerA[2];
  const dx=b[0]-listenerB[0]-x, dy=b[1]-listenerB[1]-y, dz=b[2]-listenerB[2]-z;
  const q=dx*dx+dy*dy+dz*dz;
  const t=q>1e-9 ? clamp(-(x*dx+y*dy+z*dz)/q) : 0;
  return {distance:Math.hypot(x+dx*t,y+dy*t,z+dz*t),fraction:t,position:[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]};
}
