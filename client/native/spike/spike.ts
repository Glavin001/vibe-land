// Phase 0 feasibility spike for the native macOS app (mystralnative).
// Proves, inside the mystral runtime: three/webgpu draws an InstancedMesh
// scene, the shared Rust WASM module instantiates from file:// bytes, and
// (optionally, SPIKE_WT_URL) a WebTransport session opens.
//
//   native/spike/build.sh [name] [alt three.webgpu.js]   → native/spike/dist/<name>.js
//   cd native/spike/dist && $MYSTRAL_ROOT/build/mystral run spike.js --headless --frames 200 --screenshot out.png
//   SPIKE_FLAGS=noshadow,noaa,nofog,... native/spike/build.sh   (bisect renderer features)
//
// Findings (2026-10-04, M3 Max, macOS 14.4, mystral fork branch vibe-land):
// - three 0.170 three/webgpu renders InstancedMesh + MeshStandardMaterial,
//   fog and MSAA; 0.182 is not needed.
// - Shadow maps render a blank frame (no Dawn validation error), so the
//   WebGPU path keeps shadows off for now.
// - The shared WASM must use wasm-bindgen's initSync: async
//   WebAssembly.instantiate never resolves under mystral's V8.
// - process.env is always empty under mystral, so SPIKE_WT_URL needs a
//   runtime that fills it in.
import * as THREE from 'three/webgpu';
import initShared, { initSync as initSharedSync, vehicle_definitions_json } from '../../src/wasm/pkg/vibe_land_shared.js';

declare const canvas: HTMLCanvasElement & { width: number; height: number };
const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
// Build-time feature switches for bisecting the renderer (esbuild --define).
declare const SPIKE_FLAGS: string;
const flags = new Set((typeof SPIKE_FLAGS === 'string' ? SPIKE_FLAGS : '').split(',').filter(Boolean));
const results: Record<string, string> = {};
const log = (...args: unknown[]) => console.log('[spike]', ...args);

async function checkWasm() {
  log('wasm: typeof WebAssembly =', typeof WebAssembly);
  const response = await fetch('file://./assets/vibe_land_shared_bg.wasm');
  const bytes = await response.arrayBuffer();
  log('wasm: fetched', bytes.byteLength, 'bytes');
  if (env.SPIKE_WASM_ASYNC) await initShared({ module_or_path: bytes });
  else initSharedSync({ module: bytes });
  log('wasm: instantiated');
  const vehicles = JSON.parse(vehicle_definitions_json()) as unknown[];
  results.wasm = `ok (${bytes.byteLength} bytes, ${vehicles.length} vehicle definitions)`;
}

async function checkWebTransport(url: string) {
  const transport = new WebTransport(url);
  await transport.ready;
  let datagrams = 0;
  const reader = transport.datagrams.readable.getReader();
  const started = performance.now();
  void (async () => {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
      datagrams += 1;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const seconds = (performance.now() - started) / 1000;
  results.webtransport = `ok (${(datagrams / seconds).toFixed(1)} datagrams/s)`;
  transport.close();
}

async function main() {
  const width = canvas.width || 1280;
  const height = canvas.height || 720;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: !flags.has('noaa'), powerPreference: 'high-performance' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = !flags.has('noshadow');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8d0);
  if (!flags.has('nofog')) scene.fog = new THREE.Fog(0x9fb8d0, 40, 140);
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 400);
  camera.position.set(30, 22, 30);
  camera.lookAt(0, 4, 0);

  if (flags.has('nohemi')) scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  else scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(20, 40, 10);
  sun.castShadow = true;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x6b7a5a }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  if (!flags.has('noground')) scene.add(ground);

  // A small "city": one InstancedMesh of boxes, the same draw shape the city
  // chunk layer uses for box chunks.
  const towers = 12;
  const perTower = 40;
  const boxes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
    towers * perTower,
  );
  boxes.castShadow = true;
  boxes.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const colour = new THREE.Color();
  let index = 0;
  for (let t = 0; t < towers; t += 1) {
    const tx = (t % 4) * 8 - 12;
    const tz = Math.floor(t / 4) * 8 - 8;
    for (let k = 0; k < perTower; k += 1) {
      matrix.makeTranslation(tx + (k % 2) * 1.05, 0.5 + Math.floor(k / 4) * 1.05, tz + (Math.floor(k / 2) % 2) * 1.05);
      boxes.setMatrixAt(index, matrix);
      if (!flags.has('noinstancecolor')) boxes.setColorAt(index, colour.setHSL((t * 0.08) % 1, 0.35, 0.6));
      index += 1;
    }
  }
  if (!flags.has('noinstanced')) scene.add(boxes);

  let frames = 0;
  const started = performance.now();
  function frame() {
    const t = (performance.now() - started) / 1000;
    camera.position.set(Math.cos(t * 0.2) * 40, 22, Math.sin(t * 0.2) * 40);
    camera.lookAt(0, 4, 0);
    renderer.render(scene, camera);
    frames += 1;
    if (frames === 120) {
      results.render = `ok (${(frames / ((performance.now() - started) / 1000)).toFixed(1)} fps over 120 frames)`;
      log('results', JSON.stringify(results, null, 2));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (env.SPIKE_SKIP_WASM || flags.has('nowasm')) results.wasm = 'skipped';
  else try { await checkWasm(); } catch (error) { results.wasm = `FAILED: ${String(error)}`; }
  const wtUrl = env.SPIKE_WT_URL;
  if (wtUrl) {
    try { await checkWebTransport(wtUrl); } catch (error) { results.webtransport = `FAILED: ${String(error)}`; }
  } else {
    results.webtransport = 'skipped (set SPIKE_WT_URL)';
  }
  log('wasm:', results.wasm, '| webtransport:', results.webtransport);
}

main().catch((error) => console.error('[spike] fatal', error));
