// The dust's one shared shape: a 128³ optical field, baked once.
//
// Every parcel is the same cloud, rotated, mirrored, scaled and eroded per
// instance; the raymarcher does one trilinear fetch per step and nothing
// else. What it fetches is baked here on the GPU, layer by layer, from a 64³
// tileable noise texture built on the CPU. A CPU bake of the field itself
// would be ~60 million noise evaluations -- seconds -- and an 8 MB upload;
// 128 quads of 128×128 fragments are a few milliseconds, spread over frames
// so the first one is not a hitch.
//
// RGBA8, never float: unsigned-byte colour is renderable everywhere the
// pipeline's HalfFloat beauty target is, and one more extension is one more
// way to have no dust.

import * as THREE from 'three';

import { FIELD_BAKE_FRAGMENT, FIELD_BAKE_VERTEX } from './dustVolumeShaders';

export const NOISE_SIZE = 64;
export const FIELD_SIZE = 128;
const LAYERS_PER_FRAME = 16;

/**
 * Tileable gradient noise on a 64³ grid: three octaves on periodic lattices
 * (8, 16, 32 cells), so `RepeatWrapping` shows no seam. Perlin's improved
 * noise is not periodic at any frequency you would want, and the seam it
 * leaves runs straight through every cloud.
 */
export function buildTileableNoise(size = NOISE_SIZE, seed = 1234): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size * size * size));
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const octaves = [
    { period: 8, weight: 0.55 },
    { period: 16, weight: 0.3 },
    { period: 32, weight: 0.15 },
  ];
  // One random unit gradient per lattice point per octave.
  const grads = octaves.map(({ period }) => {
    const g = new Float32Array(period * period * period * 3);
    for (let i = 0; i < period * period * period; i += 1) {
      const z = rnd() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const a = rnd() * Math.PI * 2;
      g[i * 3] = Math.cos(a) * r;
      g[i * 3 + 1] = Math.sin(a) * r;
      g[i * 3 + 2] = z;
    }
    return g;
  });
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  let min = Infinity;
  let max = -Infinity;
  const values = new Float32Array(size * size * size);
  for (let z = 0, i = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1, i += 1) {
        let v = 0;
        for (let o = 0; o < octaves.length; o += 1) {
          const { period, weight } = octaves[o];
          const g = grads[o];
          const scale = period / size;
          const px = x * scale;
          const py = y * scale;
          const pz = z * scale;
          const x0 = Math.floor(px);
          const y0 = Math.floor(py);
          const z0 = Math.floor(pz);
          const fx = px - x0;
          const fy = py - y0;
          const fz = pz - z0;
          const ux = fade(fx);
          const uy = fade(fy);
          const uz = fade(fz);
          let acc = 0;
          for (let c = 0; c < 8; c += 1) {
            const cx = c & 1;
            const cy = (c >> 1) & 1;
            const cz = (c >> 2) & 1;
            const lx = (x0 + cx) % period;
            const ly = (y0 + cy) % period;
            const lz = (z0 + cz) % period;
            const gi = ((lz * period + ly) * period + lx) * 3;
            const dot = g[gi] * (fx - cx) + g[gi + 1] * (fy - cy) + g[gi + 2] * (fz - cz);
            const wx = cx ? ux : 1 - ux;
            const wy = cy ? uy : 1 - uy;
            const wz = cz ? uz : 1 - uz;
            acc += dot * wx * wy * wz;
          }
          v += acc * weight;
        }
        values[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  const range = max - min || 1;
  for (let i = 0; i < values.length; i += 1) {
    out[i] = Math.round(((values[i] - min) / range) * 255);
  }
  return out;
}

const noiseCache = new Map<string, Uint8Array<ArrayBuffer>>();

/**
 * `buildTileableNoise`, built once per (size, seed) for the page. It is pure,
 * and a 64³ build is 40-85 ms of main thread: every DustFieldBake used to
 * rebuild it, i.e. every time the volumetric renderer was created -- and the
 * render governor's dust-sprite rung and its recovery probe recreate it
 * mid-storm. Callers must not write to the array (textures only read it).
 */
export function sharedTileableNoise(size = NOISE_SIZE, seed = 1234): Uint8Array<ArrayBuffer> {
  const key = `${size}:${seed}`;
  let noise = noiseCache.get(key);
  if (!noise) {
    noise = buildTileableNoise(size, seed);
    noiseCache.set(key, noise);
  }
  return noise;
}

export class DustFieldBake {
  readonly noise: THREE.Data3DTexture;
  readonly field: THREE.WebGL3DRenderTarget;
  /** True once every layer is baked. */
  ready = false;
  /** True if the GL could not render to a 3D texture; use sprites. */
  failed = false;
  private nextLayer = 0;
  private readonly material: THREE.ShaderMaterial;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly quad: THREE.PlaneGeometry;

  constructor(sunElevationDeg: number) {
    const data = sharedTileableNoise();
    const noise = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    noise.format = THREE.RedFormat;
    noise.type = THREE.UnsignedByteType;
    noise.minFilter = THREE.LinearFilter;
    noise.magFilter = THREE.LinearFilter;
    noise.wrapS = THREE.RepeatWrapping;
    noise.wrapT = THREE.RepeatWrapping;
    noise.wrapR = THREE.RepeatWrapping;
    noise.unpackAlignment = 1;
    noise.needsUpdate = true;
    this.noise = noise;

    const field = new THREE.WebGL3DRenderTarget(FIELD_SIZE, FIELD_SIZE, FIELD_SIZE, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    field.texture.format = THREE.RGBAFormat;
    field.texture.type = THREE.UnsignedByteType;
    field.texture.minFilter = THREE.LinearFilter;
    field.texture.magFilter = THREE.LinearFilter;
    field.texture.wrapS = THREE.ClampToEdgeWrapping;
    field.texture.wrapT = THREE.ClampToEdgeWrapping;
    field.texture.wrapR = THREE.ClampToEdgeWrapping;
    field.texture.generateMipmaps = false;
    this.field = field;

    // Field space: the sun sits along +X at the scene's elevation. The
    // instance yaw turns +X toward the real sun azimuth at draw time.
    const el = (sunElevationDeg * Math.PI) / 180;
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tNoise: { value: noise },
        uLayer: { value: 0 },
        uLayers: { value: FIELD_SIZE },
        uLightDir: { value: new THREE.Vector3(Math.cos(el), Math.sin(el), 0) },
      },
      vertexShader: FIELD_BAKE_VERTEX,
      fragmentShader: FIELD_BAKE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.PlaneGeometry(2, 2);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.Mesh(this.quad, this.material));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** Bakes a few layers. Call once per frame until `ready`. */
  step(renderer: THREE.WebGLRenderer): void {
    if (this.ready || this.failed) return;
    const previous = renderer.getRenderTarget();
    const end = Math.min(FIELD_SIZE, this.nextLayer + LAYERS_PER_FRAME);
    for (let layer = this.nextLayer; layer < end; layer += 1) {
      this.material.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(this.field, layer);
      renderer.render(this.scene, this.camera);
      if (layer === 0) {
        const gl = renderer.getContext();
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          this.failed = true;
          renderer.setRenderTarget(previous);
          return;
        }
      }
    }
    this.nextLayer = end;
    renderer.setRenderTarget(previous);
    if (end >= FIELD_SIZE) this.ready = true;
  }

  dispose(): void {
    this.noise.dispose();
    this.field.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
