// One 16×12×16 m fluid volume, placed at the most violent nearby break.
//
// Where the parcels are shapes evaluated from their age, this is dust that
// actually flows: advected, pushed by the blast, settling, pooling against
// the walls the collider mask says are there. It is Ember's single-brick
// solver (lib/vfx/volume.js) with every 3D field stored as a 2D slice atlas
// (fluidAtlas.ts), because that is what WebGL2 can update in one draw.
//
// Lifecycle: placed by the dust layer when a big enough source arrives near
// the camera and the brick is free; fed by every source inside it; retired
// after a quiet spell or once the camera walks away. The parcels born inside
// it fade as it takes over (coverage), so the two never double up.

import * as THREE from 'three';

import type { DustSource } from '../../city/destructionEvents';
import { atlasGlsl, atlasLayout, type AtlasLayout } from './fluidAtlas';
import {
  APPEARANCE_FRAGMENT,
  BRICK_FRAGMENT,
  BRICK_VERTEX,
  DIVERGENCE_FRAGMENT,
  DYE_FRAGMENT,
  FLUID_MAX_SOURCES,
  FLUID_VERTEX,
  PRESSURE_FRAGMENT,
  PROJECT_FRAGMENT,
  VELOCITY_FRAGMENT,
} from './fluidShaders';

export type FluidQuality = 'fast' | 'balanced';

export const BRICK_SIZE_M: readonly [number, number, number] = [16, 12, 16];
const STEP_S = 1 / 60;
const MAX_STEPS_PER_FRAME = 2;
/** A source injects for this long. */
const SOURCE_MS = 250;
/** Retire after this long with nothing injected. Dissipation has taken ~90% by then. */
const IDLE_RETIRE_MS = 9000;
/** Or once the camera is this far from the brick's centre. */
const RETIRE_DISTANCE_M = 100;
/** Parcels inside the brick fade out over this long after it is placed. */
const COVERAGE_RAMP_MS = 1500;

const QUALITY: Record<FluidQuality, { grid: [number, number, number]; jacobi: number; steps: number }> = {
  fast: { grid: [48, 36, 48], jacobi: 4, steps: 56 },
  balanced: { grid: [64, 48, 64], jacobi: 8, steps: 80 },
};

interface Injection {
  pos: THREE.Vector4;
  rate: THREE.Vector4;
  untilMs: number;
}

function target(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class FluidBrick {
  readonly layout: AtlasLayout;
  readonly quality: FluidQuality;
  readonly origin = new THREE.Vector3();
  readonly size = new THREE.Vector3(...BRICK_SIZE_M);
  active = false;
  placedAtMs = 0;
  lastFedMs = 0;
  /** Steps run since placement; the diagnostics read it. */
  steps = 0;

  private velA: THREE.WebGLRenderTarget;
  private velB: THREE.WebGLRenderTarget;
  private dyeA: THREE.WebGLRenderTarget;
  private dyeB: THREE.WebGLRenderTarget;
  private pA: THREE.WebGLRenderTarget;
  private pB: THREE.WebGLRenderTarget;
  private div: THREE.WebGLRenderTarget;
  private appearance: THREE.WebGLRenderTarget;
  private readonly occupancy: THREE.DataTexture;
  private readonly occupancyData: Uint8Array<ArrayBuffer>;
  private readonly quad: THREE.PlaneGeometry;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly passes: Record<'velocity' | 'divergence' | 'pressure' | 'project' | 'dye' | 'appearance', { material: THREE.ShaderMaterial; scene: THREE.Scene }>;
  private readonly brickMaterial: THREE.ShaderMaterial;
  private readonly brickMesh: THREE.Mesh;
  readonly brickScene = new THREE.Scene();
  private readonly injections: Injection[] = [];
  private accumulator = 0;
  private simTime = 0;
  private readonly sourcePos: THREE.Vector4[];
  private readonly sourceRate: THREE.Vector4[];
  private readonly cell = new THREE.Vector3();

  constructor(quality: FluidQuality, noise: THREE.Data3DTexture) {
    this.quality = quality;
    const q = QUALITY[quality];
    this.layout = atlasLayout(q.grid[0], q.grid[1], q.grid[2]);
    const { width, height } = this.layout;
    this.velA = target(width, height);
    this.velB = target(width, height);
    this.dyeA = target(width, height);
    this.dyeB = target(width, height);
    this.pA = target(width, height);
    this.pB = target(width, height);
    this.div = target(width, height);
    this.appearance = target(width, height);
    this.occupancyData = new Uint8Array(new ArrayBuffer(width * height));
    this.occupancy = new THREE.DataTexture(this.occupancyData, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    this.occupancy.minFilter = THREE.NearestFilter;
    this.occupancy.magFilter = THREE.NearestFilter;
    this.occupancy.unpackAlignment = 1;
    this.occupancy.needsUpdate = true;
    this.cell.set(this.size.x / q.grid[0], this.size.y / q.grid[1], this.size.z / q.grid[2]);
    this.sourcePos = Array.from({ length: FLUID_MAX_SOURCES }, () => new THREE.Vector4());
    this.sourceRate = Array.from({ length: FLUID_MAX_SOURCES }, () => new THREE.Vector4());

    const atlas = atlasGlsl(this.layout);
    const common = () => ({
      uDt: { value: STEP_S },
      uTime: { value: 0 },
      uCell: { value: this.cell },
      uOrigin: { value: this.origin },
      tOccupancy: { value: this.occupancy },
    });
    const make = (fragment: string, uniforms: Record<string, THREE.IUniform>) => {
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: { ...common(), ...uniforms },
        vertexShader: FLUID_VERTEX,
        fragmentShader: fragment,
        depthTest: false,
        depthWrite: false,
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(this.quad, material));
      return { material, scene };
    };
    this.quad = new THREE.PlaneGeometry(2, 2);
    this.passes = {
      velocity: make(VELOCITY_FRAGMENT(atlas), {
        tVelocity: { value: null },
        tDye: { value: null },
        uTurbulence: { value: 2.0 },
        uWindX: { value: 0 },
        uWindZ: { value: 0 },
        uSourceCount: { value: 0 },
        uSourcePos: { value: this.sourcePos },
        uSourceRate: { value: this.sourceRate },
      }),
      divergence: make(DIVERGENCE_FRAGMENT(atlas), { tVelocity: { value: null } }),
      pressure: make(PRESSURE_FRAGMENT(atlas), { tPressure: { value: null }, tDivergence: { value: null } }),
      project: make(PROJECT_FRAGMENT(atlas), { tVelocity: { value: null }, tPressure: { value: null } }),
      dye: make(DYE_FRAGMENT(atlas), {
        tDye: { value: null },
        tVelocity: { value: null },
        tNoise: { value: noise },
        uDissipation: { value: 0.24 },
        uCooling: { value: 0.18 },
        uSourceCount: { value: 0 },
        uSourcePos: { value: this.sourcePos },
        uSourceRate: { value: this.sourceRate },
      }),
      appearance: make(APPEARANCE_FRAGMENT(atlas), {
        tDye: { value: null },
        tNoise: { value: noise },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
        uGroundColor: { value: new THREE.Color(0.2, 0.18, 0.15) },
        uAlbedo: { value: new THREE.Color(0.5, 0.42, 0.35) },
      }),
    };

    this.brickMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tAppearance: { value: this.appearance.texture },
        tDepth: { value: null },
        uDepthScale: { value: 2 },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
        uCamForward: { value: new THREE.Vector3(0, 0, -1) },
        uBrickMin: { value: this.origin },
        uBrickSize: { value: this.size },
        uSteps: { value: q.steps },
        uFogColor: { value: new THREE.Color(0.7, 0.7, 0.7) },
        uFogDensity: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: BRICK_VERTEX,
      fragmentShader: BRICK_FRAGMENT(atlas),
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
    });
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.brickMesh = new THREE.Mesh(box, this.brickMaterial);
    this.brickMesh.frustumCulled = false;
    this.brickScene.add(this.brickMesh);
  }

  /** Uniforms the pass shares with the parcel volume. */
  get brickUniforms(): Record<string, THREE.IUniform> {
    return this.brickMaterial.uniforms;
  }

  setLighting(sunDir: THREE.Vector3, sunColor: THREE.Color, skyColor: THREE.Color, groundColor: THREE.Color, albedo: THREE.Color): void {
    const u = this.passes.appearance.material.uniforms;
    (u.uLightDir.value as THREE.Vector3).copy(sunDir);
    (u.uSunColor.value as THREE.Color).copy(sunColor);
    (u.uSkyColor.value as THREE.Color).copy(skyColor);
    (u.uGroundColor.value as THREE.Color).copy(groundColor);
    (u.uAlbedo.value as THREE.Color).copy(albedo);
  }

  setWind(x: number, z: number): void {
    const u = this.passes.velocity.material.uniforms;
    u.uWindX.value = x * 0.5;
    u.uWindZ.value = z * 0.5;
  }

  /** Whether a world point is inside the brick. */
  contains(x: number, y: number, z: number): boolean {
    if (!this.active) return false;
    const o = this.origin;
    const s = this.size;
    return x >= o.x && x < o.x + s.x && y >= o.y && y < o.y + s.y && z >= o.z && z < o.z + s.z;
  }

  /** 0 at placement, 1 after the ramp: how much the brick has taken over from parcels inside it. */
  coverage(nowMs: number): number {
    if (!this.active) return 0;
    return Math.min(1, (nowMs - this.placedAtMs) / COVERAGE_RAMP_MS);
  }

  /** How ready the brick is to be moved: free, or long quiet. */
  idleFor(nowMs: number): number {
    return this.active ? nowMs - this.lastFedMs : Infinity;
  }

  /**
   * Put the brick around a source: the source a third of the way up and
   * centred in plan, snapped to half a metre, never below the ground.
   */
  place(x: number, y: number, z: number, nowMs: number, renderer: THREE.WebGLRenderer): void {
    const snap = (v: number) => Math.round(v * 2) / 2;
    this.origin.set(snap(x - this.size.x / 2), Math.max(0, snap(y - this.size.y / 3)), snap(z - this.size.z / 2));
    this.active = true;
    this.placedAtMs = nowMs;
    this.lastFedMs = nowMs;
    this.injections.length = 0;
    this.steps = 0;
    this.accumulator = 0;
    this.clearFields(renderer);
  }

  retire(): void {
    this.active = false;
    this.injections.length = 0;
  }

  /** Feed a source inside the brick. Ignored if it is not inside. */
  inject(source: DustSource, nowMs: number): boolean {
    if (!this.contains(source.x, source.y, source.z)) return false;
    const rate = Math.min(35, source.magnitude * 0.5);
    if (rate <= 0) return false;
    const local = new THREE.Vector4(
      (source.x + source.nx * 0.4 - this.origin.x) / this.cell.x,
      (source.y + source.ny * 0.4 - this.origin.y) / this.cell.y,
      (source.z + source.nz * 0.4 - this.origin.z) / this.cell.z,
      Math.min(4, 1 + Math.cbrt(source.magnitude) * 0.5),
    );
    const heat = source.kind === 'impact' ? 0.01 : 0.025;
    const pulse = source.kind === 'impact' ? 1 : 0.6;
    if (this.injections.length >= FLUID_MAX_SOURCES) this.injections.shift();
    this.injections.push({ pos: local, rate: new THREE.Vector4(rate, heat, pulse, 0), untilMs: nowMs + SOURCE_MS });
    this.lastFedMs = nowMs;
    return true;
  }

  /** Static geometry inside the brick, as an atlas-shaped mask; see fluidColliders.ts. */
  writeOccupancy(fill: (data: Uint8Array) => void): void {
    fill(this.occupancyData);
    this.occupancy.needsUpdate = true;
  }

  private clearFields(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget();
    const color = new THREE.Color();
    renderer.getClearColor(color);
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const t of [this.velA, this.velB, this.dyeA, this.dyeB, this.pA, this.pB, this.div, this.appearance]) {
      renderer.setRenderTarget(t);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(previous);
    renderer.setClearColor(color, alpha);
  }

  /** Advance the simulation by up to two fixed steps and refresh the appearance. */
  step(renderer: THREE.WebGLRenderer, nowMs: number, dtSeconds: number): number {
    if (!this.active) return 0;
    this.accumulator += Math.min(dtSeconds, 0.1);
    let stepsRun = 0;
    // Pulses decay per step, so they are set once per frame from the live list.
    let count = 0;
    for (let i = this.injections.length - 1; i >= 0; i -= 1) {
      if (this.injections[i].untilMs < nowMs) this.injections.splice(i, 1);
    }
    for (const inj of this.injections) {
      this.sourcePos[count].copy(inj.pos);
      this.sourceRate[count].copy(inj.rate);
      count += 1;
    }
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    while (this.accumulator >= STEP_S && stepsRun < MAX_STEPS_PER_FRAME) {
      this.accumulator -= STEP_S;
      this.simTime += STEP_S;
      this.runStep(renderer, count);
      for (const inj of this.injections) inj.rate.z *= 0.82;
      stepsRun += 1;
      this.steps += 1;
    }
    if (this.accumulator > STEP_S * MAX_STEPS_PER_FRAME) this.accumulator = 0;
    if (stepsRun > 0) {
      const a = this.passes.appearance;
      a.material.uniforms.tDye.value = this.dyeA.texture;
      a.material.uniforms.uTime.value = this.simTime;
      renderer.setRenderTarget(this.appearance);
      renderer.render(a.scene, this.camera);
    }
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(previous);
    return stepsRun;
  }

  private runStep(renderer: THREE.WebGLRenderer, sourceCount: number): void {
    const q = QUALITY[this.quality];
    const v = this.passes.velocity;
    v.material.uniforms.tVelocity.value = this.velA.texture;
    v.material.uniforms.tDye.value = this.dyeA.texture;
    v.material.uniforms.uTime.value = this.simTime;
    v.material.uniforms.uSourceCount.value = sourceCount;
    renderer.setRenderTarget(this.velB);
    renderer.render(v.scene, this.camera);

    const d = this.passes.divergence;
    d.material.uniforms.tVelocity.value = this.velB.texture;
    renderer.setRenderTarget(this.div);
    renderer.render(d.scene, this.camera);

    const p = this.passes.pressure;
    p.material.uniforms.tDivergence.value = this.div.texture;
    for (let i = 0; i < q.jacobi; i += 1) {
      p.material.uniforms.tPressure.value = this.pA.texture;
      renderer.setRenderTarget(this.pB);
      renderer.render(p.scene, this.camera);
      [this.pA, this.pB] = [this.pB, this.pA];
    }

    const pr = this.passes.project;
    pr.material.uniforms.tVelocity.value = this.velB.texture;
    pr.material.uniforms.tPressure.value = this.pA.texture;
    renderer.setRenderTarget(this.velA);
    renderer.render(pr.scene, this.camera);

    const dye = this.passes.dye;
    dye.material.uniforms.tDye.value = this.dyeA.texture;
    dye.material.uniforms.tVelocity.value = this.velA.texture;
    dye.material.uniforms.uTime.value = this.simTime;
    dye.material.uniforms.uSourceCount.value = sourceCount;
    renderer.setRenderTarget(this.dyeB);
    renderer.render(dye.scene, this.camera);
    [this.dyeA, this.dyeB] = [this.dyeB, this.dyeA];
  }

  /** Distance from a point to the brick's centre. */
  distanceTo(x: number, y: number, z: number): number {
    const cx = this.origin.x + this.size.x / 2;
    const cy = this.origin.y + this.size.y / 2;
    const cz = this.origin.z + this.size.z / 2;
    return Math.hypot(x - cx, y - cy, z - cz);
  }

  /** Retire when quiet for long enough or the camera has left. Returns true if retired. */
  retireIfDone(nowMs: number, camera: THREE.Vector3): boolean {
    if (!this.active) return false;
    if (nowMs - this.lastFedMs > IDLE_RETIRE_MS || this.distanceTo(camera.x, camera.y, camera.z) > RETIRE_DISTANCE_M) {
      this.retire();
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const t of [this.velA, this.velB, this.dyeA, this.dyeB, this.pA, this.pB, this.div, this.appearance]) t.dispose();
    for (const pass of Object.values(this.passes)) pass.material.dispose();
    this.brickMaterial.dispose();
    this.brickMesh.geometry.dispose();
    this.occupancy.dispose();
    this.quad.dispose();
  }
}
