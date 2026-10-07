// Integer hashes and noise for the fracture surfaces.
//
// Integer mixing (Math.imul) rather than the sin-based shader hash: the same
// inputs give the same bits on every JS engine, so a crack generated in the
// browser and in the native app is the same crack, and tests can pin values.

/** murmur3-style finaliser over any number of 32-bit inputs. */
export function hashU32(...values: number[]): number {
  let h = 0x9e37_79b9;
  for (const value of values) {
    let k = value | 0;
    k = Math.imul(k, 0xcc9e_2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b87_3593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe654_6b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85eb_ca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2_ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [0, 1). */
export const hash01 = (...values: number[]): number => hashU32(...values) / 4_294_967_296;

/** Seeded PRNG (mulberry32): a deterministic stream for specimen generation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b_79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Lattice value noise in [-1, 1]. Continuous, C2 between cells. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = quintic(x - ix);
  const fy = quintic(y - iy);
  const fz = quintic(z - iz);
  const v = (dx: number, dy: number, dz: number): number => hash01(ix + dx, iy + dy, iz + dz, seed) * 2 - 1;
  const x00 = v(0, 0, 0) + (v(1, 0, 0) - v(0, 0, 0)) * fx;
  const x10 = v(0, 1, 0) + (v(1, 1, 0) - v(0, 1, 0)) * fx;
  const x01 = v(0, 0, 1) + (v(1, 0, 1) - v(0, 0, 1)) * fx;
  const x11 = v(0, 1, 1) + (v(1, 1, 1) - v(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Fractal sum of value noise, normalised to roughly [-1, 1]. */
export function fbm3(
  x: number, y: number, z: number, seed: number, octaves = 4, lacunarity = 2.03, gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += valueNoise3(x * f, y * f, z * f, seed + o * 101) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/**
 * Cellular (Worley) noise: distance to the nearest and second-nearest feature
 * point, and the nearest cell's hash. One jittered point per unit cell.
 */
export function worley3(x: number, y: number, z: number, seed: number): { f1: number; f2: number; id: number } {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const cx = ix + dx;
        const cy = iy + dy;
        const cz = iz + dz;
        const h = hashU32(cx, cy, cz, seed);
        const px = cx + ((h & 0x3ff) / 1024);
        const py = cy + (((h >>> 10) & 0x3ff) / 1024);
        const pz = cz + (((h >>> 20) & 0x3ff) / 1024);
        const d = Math.hypot(px - x, py - y, pz - z);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = h;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  return { f1, f2, id };
}
