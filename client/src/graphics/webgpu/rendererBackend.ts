// Renderer selection for the two builds (see __WEBGPU__ in vite.config.ts).
//
// The WebGL client passes its Canvas props through unchanged. The webgpu
// build (dev:webgpu, the native app) swaps in a WebGPURenderer: R3F 8
// creates `gl` synchronously, but WebGPURenderer must `await init()` before
// its first frame, so the Canvas starts with `frameloop: 'never'` and gets
// its real frameloop back once init resolves.
//
// v1 of the WebGPU path is deliberately simple: no shadows, no custom
// shaders (see the __WEBGPU__ gates at each one).

import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';

import { fixArrayTextureGrad } from './textureGradFix';

type Frameloop = 'always' | 'demand' | 'never';

type CanvasProps = {
  gl?: unknown;
  shadows?: unknown;
  frameloop?: Frameloop;
  onCreated?: (state: RootState) => void;
};

type WebGPURendererLike = THREE.WebGLRenderer & { init: () => Promise<unknown> };

/**
 * Whether a WebGPURenderer has finished init(). R3F re-applies Canvas props
 * on every render of the page, so the props must stop saying 'never' once
 * the renderer is live, or the first re-render (joining, a HUD update)
 * stops the frame loop for good. (A later Canvas then starts its loop before
 * its own init; three skips render() until its backend is ready.)
 */
let rendererReady = false;

/** Canvas props for the current build's renderer. Identity in the WebGL build. */
export function withRenderBackend<P extends CanvasProps>(props: P): P {
  if (!__WEBGPU__) return props;
  const options = (props.gl && typeof props.gl === 'object' ? props.gl : {}) as {
    antialias?: boolean;
    powerPreference?: string;
  };
  const frameloop = props.frameloop ?? 'always';
  return {
    ...props,
    shadows: false,
    frameloop: rendererReady ? frameloop : 'never',
    gl: (canvas: HTMLCanvasElement) => createWebGPURenderer(canvas, options),
    onCreated: (state: RootState) => {
      void (state.gl as unknown as WebGPURendererLike).init().then(() => {
        rendererReady = true;
        state.set({ frameloop });
        if (frameloop !== 'never') state.invalidate();
        (globalThis as { __rendererBackend?: string }).__rendererBackend = 'webgpu';
        props.onCreated?.(state);
      });
    },
  };
}

export function createWebGPURenderer(
  canvas: HTMLCanvasElement,
  options: { antialias?: boolean; powerPreference?: string } = {},
): WebGPURendererLike {
  // `three` is three/webgpu in this build; the WebGL typings lack the class.
  const WebGPURenderer = (THREE as unknown as {
    WebGPURenderer: new (parameters: Record<string, unknown>) => WebGPURendererLike;
  }).WebGPURenderer;
  const renderer = new WebGPURenderer({
    canvas,
    antialias: options.antialias ?? true,
    powerPreference: options.powerPreference ?? 'high-performance',
  });
  // The backend is final only after init (it may fall back to WebGL2).
  fixArrayTextureGrad(renderer as unknown as Parameters<typeof fixArrayTextureGrad>[0]);
  const init = renderer.init.bind(renderer);
  renderer.init = async () => {
    const ready = await init();
    fixArrayTextureGrad(renderer as unknown as Parameters<typeof fixArrayTextureGrad>[0]);
    return ready;
  };
  return renderer;
}
