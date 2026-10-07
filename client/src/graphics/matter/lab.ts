// The web material lab's renderers: a hidden one that photographs specimens
// for the gallery (and for the parity check, window.__MATTER_LAB__), and a
// live one with orbit controls for the inspector. Both draw a MatterStage.
//
// Only imported behind __WEBGPU__ (pages/MaterialsLab.tsx).

import * as T from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { DEFAULTS, type MaterialKind, type MaterialRecipe, cloneRecipe } from './recipes';
import { MatterStage, type ShapeName, type StageOptions } from './specimens';

async function webgpuRenderer(canvas?: HTMLCanvasElement): Promise<T.WebGPURenderer> {
  const renderer = new T.WebGPURenderer({ canvas, antialias: true, alpha: false });
  await renderer.init();
  const backend = renderer.backend as unknown as { isWebGPUBackend?: boolean };
  if (!backend.isWebGPUBackend) {
    renderer.dispose();
    throw new Error('The material lab needs WebGPU (navigator.gpu); this browser fell back to WebGL2.');
  }
  return renderer;
}

/** Renders specimens one at a time into images. */
export class SpecimenCamera {
  private constructor(
    private readonly renderer: T.WebGPURenderer,
    private readonly stage: MatterStage,
  ) {}

  static async create(): Promise<SpecimenCamera> {
    const renderer = await webgpuRenderer();
    renderer.setPixelRatio(1);
    return new SpecimenCamera(renderer, new MatterStage(renderer));
  }

  /** One specimen at `size` px square, as a data URL (PNG for exact comparison). */
  async snapshot(recipe: MaterialRecipe, shape: ShapeName, size = 400, type = 'image/png'): Promise<string> {
    this.stage.setSample(recipe, shape);
    this.renderer.setSize(size, size, false);
    this.stage.camera.aspect = 1;
    this.stage.camera.updateProjectionMatrix();
    this.stage.camera.updateMatrixWorld();
    await this.renderer.compileAsync(this.stage.scene, this.stage.camera);
    // Read back in the same task as the draw, while the canvas texture is current.
    this.stage.render();
    return (this.renderer.domElement as HTMLCanvasElement).toDataURL(type, 0.93);
  }

  dispose() {
    this.stage.dispose();
    this.renderer.dispose();
  }
}

/** The inspector: one specimen, live, with orbit controls. */
export class SpecimenView {
  private frame = 0;
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  onFrameTime?: (ms: number) => void;

  private constructor(
    private readonly renderer: T.WebGPURenderer,
    readonly stage: MatterStage,
    private readonly container: HTMLElement,
  ) {
    this.controls = new OrbitControls(stage.camera, renderer.domElement as HTMLCanvasElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.045;
    this.controls.maxDistance = 24;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    let last = performance.now();
    const draw = (now: number) => {
      this.frame = requestAnimationFrame(draw);
      this.onFrameTime?.(now - last);
      last = now;
      this.controls.target.copy(stage.target);
      this.controls.update();
      stage.render();
    };
    this.frame = requestAnimationFrame(draw);
  }

  static async create(container: HTMLElement): Promise<SpecimenView> {
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);
    const renderer = await webgpuRenderer(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    return new SpecimenView(renderer, new MatterStage(renderer), container);
  }

  show(recipe: MaterialRecipe, shape: ShapeName) {
    this.stage.setSample(recipe, shape);
  }

  update(recipe: MaterialRecipe) {
    this.stage.updateRecipe(recipe);
  }

  setOptions(options: StageOptions) {
    this.stage.setOptions(options);
  }

  private resize() {
    const w = Math.max(this.container.clientWidth, 100);
    const h = Math.max(this.container.clientHeight, 100);
    this.renderer.setSize(w, h, false);
    this.stage.camera.aspect = w / h;
    this.stage.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    this.stage.dispose();
    (this.renderer.domElement as HTMLCanvasElement).remove();
    this.renderer.dispose();
  }
}

declare global {
  interface Window {
    /** Parity and screenshot hook: photograph any default recipe on any form. */
    __MATTER_LAB__?: {
      snapshot(kind: MaterialKind, shape: ShapeName, size?: number): Promise<string>;
    };
  }
}

export function installLabHook(camera: SpecimenCamera) {
  window.__MATTER_LAB__ = {
    snapshot: (kind, shape, size = 400) => camera.snapshot(cloneRecipe(DEFAULTS[kind]), shape, size),
  };
}
