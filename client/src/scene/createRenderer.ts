import * as THREE from 'three';

export interface CreateRendererOptions {
  canvas: HTMLCanvasElement;
  antialias?: boolean;
  alpha?: boolean;
  forceWebGL?: boolean;
}

export interface CreatedRenderer {
  renderer: THREE.WebGLRenderer;
  init: () => Promise<void>;
}

export function shouldForceWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  const qs = new URLSearchParams(window.location.search);
  if (qs.get('webgl') === '1' || qs.get('renderer') === 'webgl') return true;
  try {
    if (localStorage.getItem('vibeland.forceWebGL') === '1') return true;
  } catch {
    // Access can throw in private modes; treat as no override.
  }
  return false;
}

export function isWebGPUBackend(renderer: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = renderer as any;
  return Boolean(r?.isWebGPURenderer || r?.backend?.isWebGPUBackend);
}

export function createRenderer(opts: CreateRendererOptions): CreatedRenderer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebGPURenderer = (THREE as any).WebGPURenderer as
    | (new (params: Record<string, unknown>) => THREE.WebGLRenderer & {
        init: () => Promise<void>;
      })
    | undefined;

  const force = opts.forceWebGL ?? shouldForceWebGL();

  if (WebGPURenderer && !force) {
    const renderer = new WebGPURenderer({
      canvas: opts.canvas,
      antialias: opts.antialias ?? true,
      alpha: opts.alpha,
      forceWebGL: false,
    });
    return {
      renderer,
      init: () => renderer.init(),
    };
  }

  const renderer = new THREE.WebGLRenderer({
    canvas: opts.canvas,
    antialias: opts.antialias ?? true,
    alpha: opts.alpha,
  });
  return {
    renderer,
    init: async () => {},
  };
}
