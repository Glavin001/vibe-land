// The value noise the surface shaders sample, precomputed: a periodic 3D
// table of the same noise frNoiseD hashes per call (fractureNodes.ts) --
// quintic-interpolated lattice values and their analytic gradient.
//
// 128^3 RGBA8 texels over 32 lattice cells (4 texels a cell), repeating;
// r = value (0..1 for -1..1), gba = gradient / 4 (0..1 for -4..4). A
// trilinear fetch between the texels reproduces the quintic surface closely,
// and its gradient channels keep the bump smooth across texels. The lattice
// repeats every 32 cells of each octave; octaves step by 2.03 with offsets,
// so a sum of them does not visibly repeat.
//
// 8 MB, built once in about a tenth of a second. Only imported behind
// __WEBGPU__.

import * as THREE from 'three';

export const NOISE_TEXELS = 128;
export const NOISE_PERIOD = 32;

/** frHash (fractureNodes.ts) at an integer lattice point. */
function latticeHash(x: number, y: number, z: number): number {
  const fract = (v: number) => v - Math.floor(v);
  let qx = fract(x * 0.1031);
  let qy = fract(y * 0.1030);
  let qz = fract(z * 0.0973);
  const d = qx * (qy + 33.33) + qy * (qz + 33.33) + qz * (qx + 33.33);
  qx += d;
  qy += d;
  qz += d;
  return fract((qx + qy) * qz);
}

let shared: THREE.Data3DTexture | null = null;

export function fractureNoiseTexture(): THREE.Data3DTexture {
  if (shared) return shared;
  const n = NOISE_TEXELS;
  const period = NOISE_PERIOD;
  const per = n / period;
  // Lattice values, wrapped so the table tiles.
  const lattice = new Float32Array(period * period * period);
  for (let z = 0; z < period; z += 1) {
    for (let y = 0; y < period; y += 1) {
      for (let x = 0; x < period; x += 1) lattice[(z * period + y) * period + x] = latticeHash(x, y, z);
    }
  }
  const at = (x: number, y: number, z: number) => lattice[((z % period) * period + (y % period)) * period + (x % period)];
  // Only `per` distinct fractions per axis: their quintic weights once.
  const u = new Float32Array(per);
  const du = new Float32Array(per);
  for (let k = 0; k < per; k += 1) {
    const f = k / per;
    u[k] = f * f * f * (f * (f * 6 - 15) + 10);
    du[k] = 30 * f * f * (f * (f - 2) + 1);
  }
  const data = new Uint8Array(n * n * n * 4);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  let o = 0;
  for (let tz = 0; tz < n; tz += 1) {
    const iz = Math.floor(tz / per);
    const fz = tz % per;
    for (let ty = 0; ty < n; ty += 1) {
      const iy = Math.floor(ty / per);
      const fy = ty % per;
      for (let tx = 0; tx < n; tx += 1) {
        const ix = Math.floor(tx / per);
        const fx = tx % per;
        const a = at(ix, iy, iz);
        const b = at(ix + 1, iy, iz);
        const c = at(ix, iy + 1, iz);
        const d = at(ix + 1, iy + 1, iz);
        const e = at(ix, iy, iz + 1);
        const g = at(ix + 1, iy, iz + 1);
        const h = at(ix, iy + 1, iz + 1);
        const k = at(ix + 1, iy + 1, iz + 1);
        const ux = u[fx];
        const uy = u[fy];
        const uz = u[fz];
        const k1 = b - a;
        const k2 = c - a;
        const k3 = e - a;
        const k4 = a - b - c + d;
        const k5 = a - c - e + h;
        const k6 = a - b - e + g;
        const k7 = -a + b + c - d + e - g - h + k;
        const v = a + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
        const gx = du[fx] * (k1 + k4 * uy + k6 * uz + k7 * uy * uz) * 2;
        const gy = du[fy] * (k2 + k5 * uz + k4 * ux + k7 * uz * ux) * 2;
        const gz = du[fz] * (k3 + k6 * ux + k5 * uy + k7 * ux * uy) * 2;
        data[o] = byte(v);
        data[o + 1] = byte(gx / 8 + 0.5);
        data[o + 2] = byte(gy / 8 + 0.5);
        data[o + 3] = byte(gz / 8 + 0.5);
        o += 4;
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, n, n, n);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  shared = texture;
  return texture;
}
