// In-process sim probe for the native app: loads libvibe_sim (sim-native/)
// into mystral, starts its probe scene on the sim thread, and renders the
// published poses with three/webgpu straight from shared memory.
//
//   cargo build --release -p vibe-sim-native [--features physx]
//   native/spike/build-probe.sh <path to libvibe_sim.dylib>
//   cd native/spike/dist && $MYSTRAL_ROOT/build/mystral run probe.js --headless --frames 20000 --screenshot out.png
import * as THREE from 'three/webgpu';

declare const canvas: HTMLCanvasElement & { width: number; height: number };
declare const VIBE_SIM_PATH: string;
const RUN_SECONDS = 10;
declare function __mystralLoadNativeModule(path: string): any;

const log = (...args: unknown[]) => console.log('[probe]', ...args);

async function main() {
  const sim = __mystralLoadNativeModule(VIBE_SIM_PATH);
  const boxes = 64;
  const probe = sim.createProbe(boxes);
  log('backend', sim.backend, 'boxes', probe.boxes);
  const words = new Uint32Array(probe.buffer);
  const floats = new Float32Array(probe.buffer);

  const width = canvas.width || 1280;
  const height = canvas.height || 720;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8d0);
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 400);
  camera.position.set(14, 9, 14);
  camera.lookAt(0.5, 3, 0.5);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a4a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(10, 20, 6);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x6b7a5a }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.8 }),
    boxes,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const unit = new THREE.Vector3(1, 1, 1);
  const matrix = new THREE.Matrix4();
  let lastTick = 0;
  let framesWithNewTick = 0;
  let frames = 0;
  let stopped = false;
  let nextLog = 1000;
  const started = performance.now();
  const minY: number[] = [];

  function frame() {
    const slot = probe.acquire();
    const base = slot * probe.slotWords;
    const tick = words[base];
    const count = words[base + 1];
    if (tick !== lastTick) framesWithNewTick += 1;
    lastTick = tick;
    let lowest = Infinity;
    for (let i = 0; i < count; i += 1) {
      const o = base + probe.headerWords + i * probe.wordsPerBody;
      position.set(floats[o], floats[o + 1], floats[o + 2]);
      rotation.set(floats[o + 3], floats[o + 4], floats[o + 5], floats[o + 6]);
      lowest = Math.min(lowest, position.y);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, unit));
    }
    mesh.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
    frames += 1;
    const elapsed = performance.now() - started;
    if (elapsed >= nextLog && !stopped) {
      nextLog += 1000;
      minY.push(Number(lowest.toFixed(2)));
      log(`${(elapsed / 1000).toFixed(1)}s frame ${frames} sim tick ${tick} step ${words[base + 2]}us lowest box y ${lowest.toFixed(2)} fresh frames ${framesWithNewTick}`);
    }
    if (elapsed >= RUN_SECONDS * 1000 && !stopped) {
      stopped = true;
      const error = probe.stop();
      log('stopped', error ?? 'cleanly', 'lowest-y samples', JSON.stringify(minY));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((error) => console.error('[probe] fatal', error));
