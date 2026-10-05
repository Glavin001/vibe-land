// Entry point of the native macOS app (mystralnative: V8 + Dawn on Metal).
//
// There is no DOM: React renders straight into an R3F root on the canvas
// mystral provides, with a WebGPURenderer. Built by vite.native.config.ts.
import './shims';
import '../graphics/webgpu/install';

import { createRoot, events } from '@react-three/fiber';

import { createWebGPURenderer } from '../graphics/webgpu/rendererBackend';
import { setInProcessLink, type InProcessLink } from '../net/inProcessClient';
import { NativeCity } from './NativeCity';

declare const canvas: HTMLCanvasElement & { width: number; height: number };
/** Path of libvibe_sim (sim-native), baked in by vite.config.ts (VIBE_SIM_LIB). */
declare const __VIBE_SIM_LIB__: string;
declare function __mystralLoadNativeModule(path: string): {
  backend: string;
  startCity(matchId: string): InProcessLink;
};

const MATCH_ID = 'city-default';

async function main(): Promise<void> {
  // Single-player: the city server's match loop runs in this process; the
  // game connects to it in memory (net/inProcessClient.ts).
  const sim = __mystralLoadNativeModule(__VIBE_SIM_LIB__);
  console.log(`[native] sim module loaded (${sim.backend}); starting ${MATCH_ID}`);
  setInProcessLink(sim.startCity(MATCH_ID));

  const width = canvas.width || 1280;
  const height = canvas.height || 720;
  const renderer = createWebGPURenderer(canvas, { antialias: true });
  await renderer.init();
  (globalThis as { __rendererBackend?: string }).__rendererBackend = 'webgpu';

  const root = createRoot(canvas);
  root.configure({
    gl: renderer,
    events,
    size: { width, height, top: 0, left: 0 },
    dpr: 1,
    shadows: false,
    frameloop: 'always',
    camera: { fov: 75, near: 0.1, far: 200, position: [0, 5, 10] },
  });
  root.render(<NativeCity matchId={MATCH_ID} />);

  window.addEventListener('resize', () => {
    root.configure({ size: { width: canvas.width, height: canvas.height, top: 0, left: 0 } });
  });
}

main().catch((error) => console.error('[native] fatal', error));
