// Entry point of the native macOS app (mystralnative: V8 + Dawn on Metal).
//
// There is no DOM: React renders straight into an R3F root on the canvas
// mystral provides, with a WebGPURenderer. Built by vite.native.config.ts.
import './shims';
import '../graphics/webgpu/install';
// The read-only test bridge (window.__VIBE_E2E__) and the scripted controls
// (window.__VIBE_DRIVE__), as on the web: client/native/city-smoke.js drives
// the native app through them.
import '../e2eBridge';
import '../agentDrive';

import { createRoot, events, extend } from '@react-three/fiber';
import * as THREE from 'three';

import { createWebGPURenderer } from '../graphics/webgpu/rendererBackend';
import { createPointerCaptureRequest } from '../input/pointerMode';
import { sceneCanvasProps } from '../scene/RenderGovernor';
import { setInProcessLink, type InProcessLink } from '../net/inProcessClient';
import { nativeHud } from './nativeHud';
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
  const session = sim.startCity(MATCH_ID);
  setInProcessLink(session);
  // For QA and capture scripts (client/native/*.mjs): the match's debug
  // routes, and the HUD toggle.
  (globalThis as { __VIBE_NATIVE_SESSION__?: InProcessLink }).__VIBE_NATIVE_SESSION__ = session;
  (globalThis as { __VIBE_NATIVE_HUD__?: typeof nativeHud }).__VIBE_NATIVE_HUD__ = nativeHud;
  // Mouse look as in the browser: a click captures the pointer (mystral's
  // Pointer Lock, SDL relative mouse mode), Escape releases it. Without it
  // (an older runtime) the capture request falls back to drag-to-look.
  const requestCapture = createPointerCaptureRequest();
  canvas.addEventListener('mousedown', () => requestCapture(canvas));

  const width = canvas.width || 1280;
  const height = canvas.height || 720;
  const renderer = createWebGPURenderer(canvas, { antialias: true });
  await renderer.init();
  (globalThis as { __rendererBackend?: string }).__rendererBackend = 'webgpu';

  // R3F's <Canvas> registers three's classes for JSX (<mesh>, <group>, ...);
  // a bare root has to do it itself.
  extend(THREE as unknown as Parameters<typeof extend>[0]);
  const root = createRoot(canvas);
  // The web game's scene settings (shadows, tone mapping, camera); the
  // renderer, size and frame loop are the native shell's own.
  const scene = sceneCanvasProps();
  root.configure({
    gl: renderer,
    events,
    size: { width, height, top: 0, left: 0 },
    dpr: 1,
    shadows: scene.shadows,
    flat: scene.flat,
    frameloop: 'always',
    camera: scene.camera,
  });
  const store = root.render(<NativeCity matchId={MATCH_ID} />);
  // For diagnostic scripts (client/native/*.mjs): the scene, renderer and camera.
  (globalThis as { __VIBE_NATIVE_STORE__?: typeof store }).__VIBE_NATIVE_STORE__ = store;

  window.addEventListener('resize', () => {
    root.configure({ size: { width: canvas.width, height: canvas.height, top: 0, left: 0 } });
  });
}

main().catch((error) => console.error('[native] fatal', error));
