// The volumetric dust pass: evaluate every live parcel, keep the ones worth
// drawing, spend the sample budget across them, and raymarch them into a
// premultiplied target for the frame pipeline's composite.
//
// CPU work per frame is O(live parcels) analytic evaluation (dustParcelStore)
// plus a sort of what is drawn. GPU work is two instanced draws -- one at
// full resolution for what is near or small, one at half resolution for what
// is far or fills the screen -- and an upsample quad. When nothing is alive
// the pass does not run at all.

import * as THREE from 'three';

import { renderStats } from '../city/renderStats';
import type { PipelineStage, PipelineStageContext } from '../graphics/framePipelineStages';
import type { DustSource } from '../city/destructionEvents';
import { DustFieldBake } from './dustFieldBake';
import { FluidBrick, type FluidQuality } from './fluid/FluidBrick';
import type { DustOccupancy } from './dustOccupancy';
import type { AtlasLayout } from './fluid/fluidAtlas';
import type { BrickFrame } from './fluid/fluidColliders';
import {
  applySampleBudget,
  drawnAtTier,
  easeSteps,
  fogCullDistance,
  layerBlendFor,
  pixelsPerMetre,
  sortBackToFront,
  stepsFor,
  tierFor,
  TIER_STRIDE,
  type DustDrawItem,
} from './dustLod';
import {
  DustPalette,
  evalParcel,
  newDustEval,
  type DustEvalTuning,
  type DustParcelStore,
} from './dustParcelStore';
import {
  UPSAMPLE_FRAGMENT,
  UPSAMPLE_VERTEX,
  VOLUME_FRAGMENT,
  VOLUME_VERTEX,
} from './dustVolumeShaders';

/** Most parcels drawn per layer per frame. */
export const MAX_DRAW = 1024;
/** Σ pixels·steps per frame. ~1.5–2 ms on a 2022 desktop GPU at one fetch per step. */
export const SAMPLE_BUDGET = 12e6;

export interface DustLighting {
  sunDir: THREE.Vector3;
  /** Linear, already scaled by the sun's intensity. */
  sunColor: THREE.Color;
  skyColor: THREE.Color;
  groundColor: THREE.Color;
}

export interface DustRenderTuning extends DustEvalTuning {
  /** Per-frame ceiling on Σ pixels·steps. */
  budget: number;
  extinction: number;
  phaseG: number;
  sunBoost: number;
  /** Linear albedo per palette: concrete, wood, metal. */
  albedo: [THREE.Color, THREE.Color, THREE.Color];
}

interface Layer {
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  scene: THREE.Scene;
  center: THREE.InstancedBufferAttribute;
  size: THREE.InstancedBufferAttribute;
  params: THREE.InstancedBufferAttribute;
  motion: THREE.InstancedBufferAttribute;
}

const TMP_SPHERE = new THREE.Sphere();
const TMP_VEC = new THREE.Vector3();
const TMP_PROJ = new THREE.Matrix4();
const FRUSTUM = new THREE.Frustum();

export class DustVolumeRenderer implements PipelineStage {
  readonly bake: DustFieldBake;
  private readonly material: THREE.ShaderMaterial;
  private readonly upsampleMaterial: THREE.ShaderMaterial;
  private readonly upsampleScene: THREE.Scene;
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.PlaneGeometry;
  private readonly native: Layer;
  private readonly half: Layer;
  private target: THREE.WebGLRenderTarget | null = null;
  private halfTarget: THREE.WebGLRenderTarget | null = null;
  private targetDirty = false;
  private readonly stepsEased: Float32Array;
  /** Which active fluid brick steps this frame; see render(). */
  private stepTurn = 0;
  private generation: number;
  private readonly items: DustDrawItem[] = [];
  private readonly evals = newDustEval();
  private readonly nativeItems: DustDrawItem[] = [];
  private readonly halfItems: DustDrawItem[] = [];
  private sunAzimuthRad: number;
  private windX = 0;
  private windZ = 0;
  private readonly clearColor = new THREE.Color();
  private readonly lighting: DustLighting = {
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(1, 1, 1),
    skyColor: new THREE.Color(0.5, 0.6, 0.8),
    groundColor: new THREE.Color(0.2, 0.18, 0.15),
  };
  /** The near-camera fluid bricks, as many as the quality setting wants. */
  fluids: FluidBrick[] = [];
  /** The standing city as voxels around the camera, or null to draw through walls. */
  occupancy: DustOccupancy | null = null;
  /** Voxelizes the static city into a brick's occupancy; set by the layer, which has the client. */
  colliders: ((frame: BrickFrame, layout: AtlasLayout, out: Uint8Array) => number) | null = null;
  private collidersRefreshedMs = 0;
  private readonly lastCamera = new THREE.Vector3();
  /** Fluid brick placement thresholds. */
  static readonly FLUID_MIN_MAGNITUDE = 20;
  static readonly FLUID_PLACE_DISTANCE_M = 60;
  static readonly FLUID_REPLACE_IDLE_MS = 3000;
  tuning: DustRenderTuning = {
    size: 1,
    density: 1,
    lifetime: 1,
    budget: SAMPLE_BUDGET,
    extinction: 0.24,
    phaseG: 0.3,
    sunBoost: 1,
    albedo: [
      new THREE.Color(0xb3afa8).convertSRGBToLinear(),
      new THREE.Color(0x8f7250).convertSRGBToLinear(),
      new THREE.Color(0x66686c).convertSRGBToLinear(),
    ],
  };

  constructor(
    private readonly store: DustParcelStore,
    sunElevationDeg: number,
    sunAzimuthDeg: number,
  ) {
    this.bake = new DustFieldBake(sunElevationDeg);
    this.sunAzimuthRad = (sunAzimuthDeg * Math.PI) / 180;
    this.stepsEased = new Float32Array(store.capacity);
    this.generation = store.generation;

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tField: { value: this.bake.field.texture },
        tOccupancy: { value: this.bake.noise },
        uOccOrigin: { value: new THREE.Vector3() },
        uOccInvSize: { value: new THREE.Vector3(1, 1, 1) },
        uOccOn: { value: 0 },
        tDepth: { value: null },
        uDepthScale: { value: 1 },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
        uCamForward: { value: new THREE.Vector3(0, 0, -1) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSkyColor: { value: new THREE.Color(0.5, 0.6, 0.8) },
        uGroundColor: { value: new THREE.Color(0.2, 0.18, 0.15) },
        uAlbedo: { value: this.tuning.albedo },
        uFogColor: { value: new THREE.Color(0.7, 0.7, 0.7) },
        uFogDensity: { value: 0 },
        uExtinction: { value: this.tuning.extinction },
        uPhaseG: { value: this.tuning.phaseG },
      },
      vertexShader: VOLUME_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      fog: false,
      toneMapped: false,
    });
    this.native = this.buildLayer();
    this.half = this.buildLayer();

    this.quad = new THREE.PlaneGeometry(2, 2);
    this.upsampleMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tHalf: { value: null },
        tDepth: { value: null },
        uHalfSize: { value: new THREE.Vector2(1, 1) },
        uFullSize: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.1 },
        uFar: { value: 200 },
      },
      vertexShader: UPSAMPLE_VERTEX,
      fragmentShader: UPSAMPLE_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      toneMapped: false,
    });
    this.upsampleScene = new THREE.Scene();
    this.upsampleScene.add(new THREE.Mesh(this.quad, this.upsampleMaterial));
  }

  private buildLayer(): Layer {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(box.getIndex());
    geometry.setAttribute('position', box.getAttribute('position'));
    const make = (itemSize: number) => {
      const attr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_DRAW * itemSize), itemSize);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    const center = make(3);
    const size = make(3);
    const params = make(4);
    const motion = make(4);
    geometry.setAttribute('aCenter', center);
    geometry.setAttribute('aSize', size);
    geometry.setAttribute('aParams', params);
    geometry.setAttribute('aMotion', motion);
    geometry.instanceCount = 0;
    // Never culled by three: the boxes are evaluated and culled here, and a
    // box the camera is inside has no bounding sphere three would keep.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    return { geometry, mesh, scene, center, size, params, motion };
  }

  setLighting(light: DustLighting): void {
    this.lighting.sunDir.copy(light.sunDir);
    this.lighting.sunColor.copy(light.sunColor);
    this.lighting.skyColor.copy(light.skyColor);
    this.lighting.groundColor.copy(light.groundColor);
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(light.sunDir);
    (u.uSunColor.value as THREE.Color).copy(light.sunColor).multiplyScalar(this.tuning.sunBoost);
    (u.uSkyColor.value as THREE.Color).copy(light.skyColor);
    (u.uGroundColor.value as THREE.Color).copy(light.groundColor);
    this.sunAzimuthRad = Math.atan2(light.sunDir.x, light.sunDir.z);
    for (const fluid of this.fluids) {
      fluid.setLighting(
        light.sunDir,
        (u.uSunColor.value as THREE.Color),
        light.skyColor,
        light.groundColor,
        this.tuning.albedo[0],
      );
    }
  }

  setWind(x: number, z: number): void {
    this.windX = x;
    this.windZ = z;
    for (const fluid of this.fluids) fluid.setWind(x, z);
  }

  /** Create, resize or drop the fluid bricks. */
  setFluidQuality(quality: FluidQuality | 'off', count = 1): void {
    const want = quality === 'off' ? 0 : Math.max(0, count);
    if (this.fluids.length === want && (want === 0 || this.fluids[0].quality === quality)) return;
    for (const fluid of this.fluids) fluid.dispose();
    this.fluids = [];
    if (quality === 'off') return;
    for (let i = 0; i < want; i += 1) {
      const fluid = new FluidBrick(quality, this.bake.noise);
      fluid.setWind(this.windX, this.windZ);
      this.fluids.push(fluid);
    }
    this.setLighting(this.lighting);
  }

  /** Whether any live brick holds the point. */
  private inFluid(x: number, y: number, z: number): FluidBrick | null {
    for (const fluid of this.fluids) {
      if (fluid.active && fluid.contains(x, y, z)) return fluid;
    }
    return null;
  }

  /**
   * Offer a source to the brick: fed if inside it; otherwise, if it is big
   * and near and the brick is free or has been quiet, the brick moves there.
   */
  considerSource(source: DustSource, nowMs: number, renderer: THREE.WebGLRenderer): void {
    if (this.fluids.length === 0) return;
    const holder = this.inFluid(source.x, source.y, source.z);
    if (holder) {
      holder.inject(source, nowMs);
      return;
    }
    if (source.magnitude < DustVolumeRenderer.FLUID_MIN_MAGNITUDE) return;
    const cam = this.lastCamera;
    const distance = Math.hypot(source.x - cam.x, source.y - cam.y, source.z - cam.z);
    if (distance > DustVolumeRenderer.FLUID_PLACE_DISTANCE_M) return;
    // Not on top of a live brick: two overlapping volumes would each draw the same dust.
    for (const fluid of this.fluids) {
      if (fluid.active && fluid.distanceTo(source.x, source.y, source.z) < fluid.size.x * 0.9) return;
    }
    // The free brick, else the one quiet longest, if quiet long enough.
    let pick: FluidBrick | null = null;
    let quietest = -Infinity;
    for (const fluid of this.fluids) {
      const idle = fluid.idleFor(nowMs);
      if (idle > quietest) {
        quietest = idle;
        pick = fluid;
      }
    }
    if (!pick || (pick.active && quietest < DustVolumeRenderer.FLUID_REPLACE_IDLE_MS)) return;
    pick.place(source.x, source.y, source.z, nowMs, renderer);
    pick.inject(source, nowMs);
    this.refreshColliders(nowMs, true);
  }

  private refreshColliders(nowMs: number, force: boolean): void {
    if (!this.colliders) return;
    if (!force && nowMs - this.collidersRefreshedMs < 500) return;
    this.collidersRefreshedMs = nowMs;
    for (const fluid of this.fluids) {
      if (!fluid.active) continue;
      const frame: BrickFrame = {
        originX: fluid.origin.x, originY: fluid.origin.y, originZ: fluid.origin.z,
        sizeX: fluid.size.x, sizeY: fluid.size.y, sizeZ: fluid.size.z,
      };
      fluid.writeOccupancy((out) => { this.colliders!(frame, fluid.layout, out); });
    }
  }

  applyTuning(): void {
    const u = this.material.uniforms;
    u.uExtinction.value = this.tuning.extinction;
    u.uPhaseG.value = this.tuning.phaseG;
    u.uAlbedo.value = this.tuning.albedo;
  }

  output(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  resize(width: number, height: number): void {
    if (this.target && this.target.width === width && this.target.height === height) return;
    this.target?.dispose();
    this.halfTarget?.dispose();
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    const hw = Math.max(1, Math.ceil(width / 2));
    const hh = Math.max(1, Math.ceil(height / 2));
    this.halfTarget = new THREE.WebGLRenderTarget(hw, hh, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.upsampleMaterial.uniforms.tHalf.value = this.halfTarget.texture;
    (this.upsampleMaterial.uniforms.uHalfSize.value as THREE.Vector2).set(hw, hh);
    (this.upsampleMaterial.uniforms.uFullSize.value as THREE.Vector2).set(width, height);
    this.targetDirty = true;
  }

  render(ctx: PipelineStageContext): boolean {
    const { renderer, camera, scene, beauty, width, height, dt } = ctx;
    if (!this.bake.ready) {
      this.bake.step(renderer);
      if (!this.bake.ready) return false;
    }
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.resize(width, height);
    }
    const started = performance.now();
    const nowMs = started;
    const store = this.store;
    this.lastCamera.copy(camera.position);
    if (store.generation !== this.generation) {
      this.stepsEased.fill(0);
      this.generation = store.generation;
    }
    store.sweep(nowMs, this.tuning.lifetime);
    renderStats.dustParcelsLive = store.liveCount;
    let activeFluids = 0;
    for (const fluid of this.fluids) {
      if (!fluid.active) continue;
      fluid.retireIfDone(nowMs, camera.position);
      if (fluid.active) activeFluids += 1;
    }
    if (activeFluids > 0) {
      this.refreshColliders(nowMs, false);
      // One brick steps per frame, in turn. A step is a dozen dependent
      // render passes, and on the reporter's M3 a frame where both bricks
      // stepped was twice the length of one where neither did; each brick
      // still gets its two catch-up steps when its turn comes, so the sim
      // runs at the same rate -- the passes are spread across frames instead
      // of stacked in one.
      this.stepTurn += 1;
      let turn = this.stepTurn % activeFluids;
      for (const fluid of this.fluids) {
        if (!fluid.active) continue;
        if (turn === 0) {
          fluid.step(renderer, nowMs, dt * activeFluids);
          break;
        }
        turn -= 1;
      }
    }
    renderStats.dustFluidActive = activeFluids;
    if (store.liveCount === 0 && activeFluids === 0) {
      this.clearIfDirty(renderer);
      renderStats.dustDrawn = 0;
      renderStats.dustDrawnHalf = 0;
      renderStats.dustSamplesEstM = 0;
      renderStats.dustCpuMs = performance.now() - started;
      return false;
    }

    const perspective = camera as THREE.PerspectiveCamera;
    const fog = scene.fog as THREE.FogExp2 | null;
    const fogDensity = fog && 'density' in fog ? fog.density : 0;
    const cull = Math.min(perspective.far ?? 200, fogCullDistance(fogDensity));
    const pxPerM = pixelsPerMetre(perspective.fov ?? 75, height);
    const viewportPx = width * height;
    TMP_PROJ.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    FRUSTUM.setFromProjectionMatrix(TMP_PROJ);
    const cam = camera.position;

    // Select.
    const items = this.items;
    items.length = 0;
    const e = this.evals;
    const tuning = this.tuning;
    for (let slot = 0; slot < store.capacity; slot += 1) {
      if (!store.alive[slot]) continue;
      if (!evalParcel(store, slot, nowMs, this.windX, this.windZ, tuning, e)) continue;
      const dx = e.cx - cam.x;
      const dy = e.cy - cam.y;
      const dz = e.cz - cam.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance - e.radius > cull) continue;
      TMP_SPHERE.center.set(e.cx, e.cy, e.cz);
      TMP_SPHERE.radius = e.radius * 0.87;
      if (!FRUSTUM.intersectsSphere(TMP_SPHERE)) continue;
      const projectedPx = (e.sx * pxPerM) / Math.max(distance, 1);
      if (projectedPx < 3) continue;
      const tier = tierFor(distance, e.radius);
      if (!drawnAtTier(e.serial, tier)) continue;
      const item = this.item(items.length);
      item.slot = slot;
      item.distance = distance;
      item.projectedPx = projectedPx;
      item.tier = tier;
      item.steps = 0;
      item.layerBlend = layerBlendFor(distance, e.radius, projectedPx, viewportPx);
      item.densityScale = TIER_STRIDE[tier];
      items.push(item);
    }
    if (items.length > MAX_DRAW) {
      items.sort((a, b) => a.distance - b.distance);
      items.length = MAX_DRAW;
    }
    // Steps: tier and projected size, eased per parcel.
    for (const item of items) {
      const target = stepsFor(item.tier, item.projectedPx);
      const eased = easeSteps(this.stepsEased[item.slot], target, dt);
      this.stepsEased[item.slot] = eased;
      item.steps = eased;
    }
    items.sort((a, b) => a.distance - b.distance);
    const estimate = applySampleBudget(items, this.tuning.budget, viewportPx);

    // Route to layers.
    const native = this.nativeItems;
    const half = this.halfItems;
    native.length = 0;
    half.length = 0;
    for (const item of items) {
      if (item.layerBlend > 0) native.push(item);
      if (item.layerBlend < 1) half.push(item);
    }
    sortBackToFront(native);
    sortBackToFront(half);
    this.write(this.native, native, nowMs, 1);
    this.write(this.half, half, nowMs, 0);
    renderStats.dustDrawn = native.length;
    renderStats.dustDrawnHalf = half.length;
    renderStats.dustSamplesEstM = estimate / 1e6;

    // Uniforms.
    const u = this.material.uniforms;
    u.tDepth.value = beauty.depthTexture;
    u.uNear.value = perspective.near ?? 0.1;
    u.uFar.value = perspective.far ?? 200;
    camera.getWorldDirection(u.uCamForward.value as THREE.Vector3);
    if (fog && 'color' in fog) (u.uFogColor.value as THREE.Color).copy(fog.color);
    u.uFogDensity.value = fogDensity;
    const up = this.upsampleMaterial.uniforms;
    up.tDepth.value = beauty.depthTexture;
    up.uNear.value = u.uNear.value;
    up.uFar.value = u.uFar.value;
    const brickOn = activeFluids > 0;
    for (const fluid of this.fluids) {
      if (!fluid.active) continue;
      const b = fluid.brickUniforms;
      b.tDepth.value = beauty.depthTexture;
      b.uNear.value = u.uNear.value;
      b.uFar.value = u.uFar.value;
      (b.uCamForward.value as THREE.Vector3).copy(u.uCamForward.value as THREE.Vector3);
      (b.uFogColor.value as THREE.Color).copy(u.uFogColor.value as THREE.Color);
      b.uFogDensity.value = fogDensity;
    }
    // The standing city, for the march to stop at.
    if (this.occupancy) {
      u.tOccupancy.value = this.occupancy.texture;
      (u.uOccOrigin.value as THREE.Vector3).copy(this.occupancy.origin);
      (u.uOccInvSize.value as THREE.Vector3).set(
        1 / this.occupancy.size.x, 1 / this.occupancy.size.y, 1 / this.occupancy.size.z);
      u.uOccOn.value = 1;
    } else {
      u.uOccOn.value = 0;
    }
    renderStats.dustCpuMs = performance.now() - started;

    // Draw.
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(this.clearColor);
    const previousAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    // The half-res layer: the fluid brick (always half-res: it fills the
    // view up close and its field is smooth) under the far parcels.
    const halfLayer = half.length > 0 || brickOn;
    if (halfLayer && this.halfTarget) {
      renderer.setRenderTarget(this.halfTarget);
      renderer.clear(true, false, false);
      if (brickOn) {
        // Far bricks first, for the over operator.
        const order = this.fluids.filter((f) => f.active)
          .sort((a, b) => b.distanceTo(cam.x, cam.y, cam.z) - a.distanceTo(cam.x, cam.y, cam.z));
        for (const fluid of order) renderer.render(fluid.brickScene, camera);
      }
      if (half.length > 0) {
        u.uDepthScale.value = 2;
        renderer.render(this.half.scene, camera);
      }
    }
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    if (halfLayer) {
      renderer.render(this.upsampleScene, this.quadCamera);
    }
    if (native.length > 0) {
      u.uDepthScale.value = 1;
      renderer.render(this.native.scene, camera);
    }
    renderer.setClearColor(this.clearColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
    this.targetDirty = true;
    return true;
  }

  private item(index: number): DustDrawItem {
    // Pooled: the item objects live as long as the renderer, so a frame that
    // selects a thousand parcels allocates nothing.
    let item = this.pool[index];
    if (!item) {
      item = { slot: 0, distance: 0, projectedPx: 0, tier: 0, steps: 0, layerBlend: 1, densityScale: 1 };
      this.pool[index] = item;
    }
    return item;
  }
  private readonly pool: DustDrawItem[] = [];

  private write(layer: Layer, items: DustDrawItem[], nowMs: number, nativeSide: 0 | 1): void {
    const store = this.store;
    const e = this.evals;
    const c = layer.center.array as Float32Array;
    const s = layer.size.array as Float32Array;
    const p = layer.params.array as Float32Array;
    const m = layer.motion.array as Float32Array;
    const tuning = this.tuning;
    let n = 0;
    for (const item of items) {
      if (!evalParcel(store, item.slot, nowMs, this.windX, this.windZ, tuning, e)) continue;
      let fade = e.fade * (nativeSide ? item.layerBlend : 1 - item.layerBlend);
      // Inside a live fluid brick the fluid is the dust; the parcel hands over.
      const holder = this.inFluid(e.cx, e.cy, e.cz);
      if (holder) fade *= 1 - holder.coverage(nowMs);
      if (fade <= 0.002) continue;
      const seed = e.seed;
      // Field +X faces the sun azimuth, jittered a little per parcel; the
      // mirror across the light plane keeps the baked shadow valid.
      const yaw = this.sunAzimuthRad - Math.PI / 2 + ((seed & 0xff) / 255 - 0.5) * 0.6;
      const mirror = seed & 0x100 ? -1 : 1;
      c[n * 3] = e.cx;
      c[n * 3 + 1] = e.cy;
      c[n * 3 + 2] = e.cz;
      s[n * 3] = e.sx;
      s[n * 3 + 1] = e.sy;
      s[n * 3 + 2] = e.sz;
      p[n * 4] = e.density * item.densityScale;
      p[n * 4 + 1] = yaw;
      p[n * 4 + 2] = item.steps;
      p[n * 4 + 3] = fade;
      m[n * 4] = e.age;
      m[n * 4 + 1] = e.erosion;
      m[n * 4 + 2] = mirror;
      m[n * 4 + 3] = (e.palette === DustPalette.Wood ? 1 : e.palette === DustPalette.Metal ? 2 : 0)
        + ((seed >>> 9) & 0xff) / 256;
      n += 1;
    }
    layer.geometry.instanceCount = n;
    if (n > 0) {
      for (const attr of [layer.center, layer.size, layer.params, layer.motion]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
  }

  private clearIfDirty(renderer: THREE.WebGLRenderer): void {
    if (!this.targetDirty || !this.target) return;
    const previous = renderer.getRenderTarget();
    renderer.getClearColor(this.clearColor);
    const previousAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(previous);
    renderer.setClearColor(this.clearColor, previousAlpha);
    this.targetDirty = false;
  }

  dispose(): void {
    for (const layer of [this.native, this.half]) {
      layer.geometry.dispose();
      layer.scene.clear();
    }
    this.material.dispose();
    this.upsampleMaterial.dispose();
    this.quad.dispose();
    this.target?.dispose();
    this.halfTarget?.dispose();
    for (const fluid of this.fluids) fluid.dispose();
    this.bake.dispose();
  }
}
