// The material lab's stage, without a DOM: one specimen (a recipe on a form)
// on a ground plane, under Matter's procedural studio environment, key light
// and fill. The web page (pages/MaterialsLab.tsx) adds orbit controls and a
// canvas; the native app (client/native/materials-lab.ts) drives it headless.
// Both render the same pixels, which is what makes the parity check
// (e2e/matter-parity.ts) mean anything.
//
// Ported from the Matter lab's engine; its benchmark loop, adaptive
// resolution, caustics and architecture scenes stay behind.
//
// Only imported behind __WEBGPU__.

import * as T from 'three/webgpu';

import { attachGlassBoundary, setBoundaryMode } from './glass';
import { GlassScenePass } from './glass-scene';
import { type MaterialHandle, type MaterialRecipe, createMaterial, updateMaterial } from './materials';
import { ScatteringPass } from './scattering';
import { type ShapeName, disposeObject, makeShape, setManufacturingTangents } from './shapes';
import type { MatterView } from './view';

export { SHAPES, INSPECT_SHAPES, type ShapeName } from './shapes';

export type Lighting = 'Studio' | 'Neutral' | 'Grazing' | 'Backlit';

export interface StageOptions {
  light: Lighting;
  exposure: number;
  /** Section block cut, -1..1. */
  cut: number;
  /** Turn the fine detail off (finish[3] = 0): the ablation view. */
  ablation: boolean;
  /** Baseline optics: the stock three terms instead of Matter's own. */
  optical: boolean;
}

export const DEFAULT_STAGE: StageOptions = {
  light: 'Studio',
  exposure: 1,
  cut: 0,
  ablation: false,
  optical: false,
};

/**
 * The lab's studio: a dark room, a ceiling band, one soft panel and one
 * bright strip. `v` runs from straight up (0) to straight down (1).
 *
 * three r182's WebGPU equirect lookup reads a DataTexture's first row as
 * straight DOWN; Matter was authored on r185, which reads it as up. So the
 * rows are written bottom-up here. If three is upgraded and the specimens'
 * top faces go dark (the ceiling band below the horizon), this is why:
 * e2e/matter-parity.ts shows it at once.
 */
export function environmentTexture(): T.DataTexture {
  const w = 512;
  const h = 256;
  const data = new Uint16Array(w * h * 4);
  const soft = (a: number, b: number, s: number) => Math.exp(-(((a - b) / s) ** 8));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = 1 - y / h;
      const ceiling = soft(v, 0.2, 0.15);
      const lamps = soft(u, 0.19, 0.07) * soft(v, 0.43, 0.17) * 3.5 + soft(u, 0.69, 0.016) * soft(v, 0.42, 0.22) * 6;
      const j = (y * w + x) * 4;
      data[j] = T.DataUtils.toHalfFloat(0.17 + ceiling * 0.85 + lamps);
      data[j + 1] = T.DataUtils.toHalfFloat(0.19 + ceiling * 0.85 + lamps);
      data[j + 2] = T.DataUtils.toHalfFloat(0.17 + ceiling * 0.72 + lamps);
      data[j + 3] = T.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new T.DataTexture(data, w, h, T.RGBAFormat, T.HalfFloatType);
  tex.magFilter = T.LinearFilter;
  tex.minFilter = T.LinearFilter;
  tex.mapping = T.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

const BACKGROUND = '#c5cabf';

export class MatterStage implements MatterView {
  readonly scene = new T.Scene();
  readonly camera = new T.PerspectiveCamera(35, 1, 0.001, 80);
  readonly group = new T.Group();
  readonly sceneMode = 'sample' as const;
  /** Where the camera looks: the specimen's middle. */
  readonly target = new T.Vector3(0, 0.095, 0);
  handle: MaterialHandle | null = null;
  shape: ShapeName = 'Sphere';
  options: StageOptions = { ...DEFAULT_STAGE };

  private readonly reference = new T.Group();
  private readonly key = new T.DirectionalLight(0xfff5de, 2.1);
  private readonly fill = new T.HemisphereLight(0xd8e7f7, 0x777565, 0.5);
  private readonly ground: T.Mesh;
  private readonly env = environmentTexture();
  private readonly envTarget: T.RenderTarget;
  private sample: T.Group | null = null;
  private glassScene: GlassScenePass | null = null;
  private scattering: ScatteringPass | null = null;
  private glassDispose: (() => void) | null = null;

  constructor(readonly renderer: T.WebGPURenderer) {
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;
    this.scene.background = new T.Color(BACKGROUND);
    // Prefiltered here, not left to three: r182's automatic PMREM of a
    // DataTexture equirect leaves its sharp levels black, so every glossy
    // reflection (steel, polished marble, oak's finish) went dark. The
    // renderer must be initialised before a stage is made.
    const pmrem = new T.PMREMGenerator(renderer);
    // (fromEquirectangular is missing from @types/three 0.170's WebGPU PMREMGenerator.)
    this.envTarget = (pmrem as unknown as { fromEquirectangular(t: T.Texture): T.RenderTarget }).fromEquirectangular(this.env);
    pmrem.dispose();
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.72;
    this.scene.add(this.group, this.reference);
    this.key.position.set(-0.4, 0.55, 0.35);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -0.36, right: 0.36, top: 0.4, bottom: -0.3, near: 0.01, far: 3 });
    this.key.shadow.bias = -0.0001;
    this.key.shadow.normalBias = 0.0006;
    this.key.shadow.radius = 10;
    this.scene.add(this.key, this.key.target, this.fill);
    this.ground = new T.Mesh(
      new T.PlaneGeometry(200, 200),
      new T.MeshStandardNodeMaterial({ color: 0xbec3b5, roughness: 0.8 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.0004;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.camera.position.set(0.32, 0.245, 0.38);
    this.camera.lookAt(this.target);
  }

  /** Put `recipe` on `shape`, replacing the current specimen. */
  setSample(recipe: MaterialRecipe, shape: ShapeName) {
    disposeObject(this.reference, true);
    this.reference.clear();
    this.glassDispose?.();
    this.glassDispose = null;
    if (this.sample) {
      this.group.remove(this.sample);
      disposeObject(this.sample);
    }
    this.handle?.dispose();
    this.handle = createMaterial(recipe);
    this.handle.material.userData.physicalThickness =
      shape === 'Thin slab' ? 0.002 : shape === 'Architectural pane' ? recipe.structure[0] : 0.18;
    this.shape = shape;
    if (recipe.kind === 'glass') this.addGlassBackdrop();
    this.sample = makeShape(shape, this.handle.material, recipe.structure[0]);
    this.group.add(this.sample);
    if (shape === 'Thin slab') this.sample.traverse((o) => (o.castShadow = false));
    if (recipe.kind === 'glass') {
      this.glassScene ??= new GlassScenePass();
      this.glassDispose = attachGlassBoundary(this.sample, this.handle, this.env, this.glassScene);
    }
    this.group.rotation.set(0, 0, 0);
    this.target.set(0, this.sample.userData.height * 0.47, 0);
    this.key.target.position.set(0, 0.08, 0);
    this.camera.lookAt(this.target);
    this.setOptions(this.options);
  }

  /** Retune the current specimen (uniforms only, unless the kind or a glass wall changes). */
  updateRecipe(recipe: MaterialRecipe) {
    if (!this.handle) return;
    const wallChanged =
      recipe.kind === 'glass' &&
      recipe.structure[0] !== this.handle.recipe.structure[0] &&
      (this.shape === 'Lathed vessel' || this.shape === 'Pipe assembly' || this.shape === 'Architectural pane');
    if (recipe.kind !== this.handle.recipe.kind || wallChanged) {
      this.setSample(recipe, this.shape);
      return;
    }
    updateMaterial(this.handle, recipe);
    this.setOptions(this.options);
  }

  setOptions(options: StageOptions) {
    this.options = { ...options };
    this.renderer.toneMappingExposure = options.exposure;
    this.scene.environmentIntensity = options.light === 'Neutral' ? 0.9 : options.light === 'Grazing' ? 0.25 : 0.72;
    this.fill.intensity = options.light === 'Neutral' ? 0.9 : 0.35;
    this.key.intensity = options.light === 'Neutral' ? 0.3 : options.light === 'Backlit' ? 4 : 2.1;
    if (options.light === 'Grazing') this.key.position.set(-0.4, 0.035, 0.08);
    else if (options.light === 'Backlit') this.key.position.set(-0.1, 0.15, -0.45);
    else this.key.position.set(-0.4, 0.55, 0.35);
    if (!this.handle) return;
    this.handle.uniforms.b.value.w = options.ablation ? 0 : 1;
    this.handle.uniforms.optics.value = options.optical ? 0 : 1;
    if (this.handle.recipe.kind === 'glass') setBoundaryMode(this.group, !options.optical);
    if (this.shape === 'Section block' && this.sample) {
      const mesh = this.sample.children[0] as T.Mesh;
      mesh.geometry.dispose();
      const depth = 0.18 - (options.cut + 1) * 0.08;
      mesh.geometry = new T.BoxGeometry(0.18, 0.18, depth, 48, 48, 32);
      mesh.geometry.translate(0, 0, (depth - 0.18) * 0.5);
      setManufacturingTangents(mesh.geometry);
    }
  }

  /** Draw one frame to the renderer's current target. */
  render() {
    if (this.glassDispose && this.glassScene) this.glassScene.capture(this);
    if (this.handle?.recipe.kind === 'marble' && !this.options.optical) {
      this.scattering ??= new ScatteringPass();
      this.scattering.render(this);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    this.glassDispose?.();
    disposeObject(this.group);
    disposeObject(this.reference, true);
    this.handle?.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as T.Material).dispose();
    this.glassScene?.dispose();
    this.scattering?.dispose();
    this.env.dispose();
    this.envTarget.dispose();
  }

  // The backboard and wire grid the lab's glass is seen against (glass.ts
  // ray-traces exactly these in 'sample' mode).
  private addGlassBackdrop() {
    const board = new T.Mesh(
      new T.PlaneGeometry(1.8, 1.5),
      new T.MeshStandardNodeMaterial({ color: 0xb9c0b2, roughness: 0.85 }),
    );
    board.position.set(0, 0.75, -0.19);
    board.receiveShadow = true;
    this.reference.add(board);
    const wire = new T.MeshStandardNodeMaterial({ color: 0x85927d, roughness: 0.8 });
    for (let i = -3; i <= 3; i++) {
      const vertical = new T.Mesh(new T.BoxGeometry(0.001, 0.32, 0.001), wire);
      vertical.position.set(i * 0.045, 0.16, -0.17);
      const horizontal = new T.Mesh(new T.BoxGeometry(0.32, 0.001, 0.001), wire);
      horizontal.position.set(0, 0.16 + i * 0.045, -0.17);
      this.reference.add(vertical, horizontal);
    }
  }
}
