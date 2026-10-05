// Performance, drawn in the scene's top-left corner (the native app has no
// DOM): render frames per second and frame times, and the simulation's tick
// rate and tick cost from the match stats the server sends once a second
// (in-process here, so the server's numbers are this machine's). Text is rasterised on a small 2D canvas (mystral's Skia), read
// back with getImageData into a DataTexture twice a second, and shown on a
// quad kept in front of the camera, over everything.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { getMatchStats } from '../app/connectPhase';

type SimStats = {
  server_tick?: number;
  physics_last_step_ms?: number;
  timings?: { total_ms?: { avg?: number; p95?: number; max?: number } };
};

const WIDTH = 512;
const HEIGHT = 80;
const UPDATE_MS = 500;
const DISTANCE = 0.5;
/** On-screen height of the panel, as a fraction of the view height. */
const SCREEN_HEIGHT = 0.07;
const MARGIN = 0.015;

export function NativeFpsCounter() {
  const group = useRef<THREE.Group>(null);
  const size = useThree((state) => state.size);
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const texture = new THREE.DataTexture(new Uint8Array(WIDTH * HEIGHT * 4), WIDTH, HEIGHT, THREE.RGBAFormat);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return { canvas, ctx, texture };
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  const counter = useRef({ frames: 0, since: performance.now(), worstMs: 0, last: performance.now() });
  const sim = useRef<{ tick: number; at: number; hz: number | null }>({ tick: -1, at: 0, hz: null });

  const rate = (value: number, good: number, ok: number) =>
    value >= good ? '#7CFC8A' : value >= ok ? '#FFD166' : '#FF6B6B';

  const draw = (fps: number, frameMs: number, worstMs: number) => {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Render: frames per second, mean and worst frame time.
    ctx.font = '26px Menlo, monospace';
    ctx.fillStyle = rate(fps, 55, 30);
    ctx.fillText(`${fps.toFixed(0).padStart(3)} FPS`, 10, 32);
    ctx.font = '17px Menlo, monospace';
    ctx.fillStyle = '#d0d4d8';
    ctx.fillText(`render ${frameMs.toFixed(1)} ms  max ${worstMs.toFixed(1)}`, 160, 30);

    // Simulation: ticks per second (from the server tick counter) and the
    // tick's cost (server timing, mean / p95 over its last second).
    const stats = getMatchStats() as SimStats | null;
    const now = performance.now();
    if (stats?.server_tick !== undefined && stats.server_tick !== sim.current.tick) {
      if (sim.current.tick >= 0 && now > sim.current.at) {
        sim.current.hz = ((stats.server_tick - sim.current.tick) * 1000) / (now - sim.current.at);
      }
      sim.current.tick = stats.server_tick;
      sim.current.at = now;
    }
    const hz = sim.current.hz;
    const tick = stats?.timings?.total_ms;
    ctx.font = '26px Menlo, monospace';
    ctx.fillStyle = hz === null ? '#d0d4d8' : rate(hz, 57, 45);
    ctx.fillText(`${hz === null ? ' --' : hz.toFixed(0).padStart(3)} TPS`, 10, 68);
    ctx.font = '17px Menlo, monospace';
    ctx.fillStyle = '#d0d4d8';
    ctx.fillText(
      tick?.avg !== undefined
        ? `sim ${tick.avg.toFixed(1)} ms  p95 ${(tick.p95 ?? 0).toFixed(1)}  physx ${(stats?.physics_last_step_ms ?? 0).toFixed(1)}`
        : 'sim waiting for stats',
      160,
      66,
    );
    // getImageData rows run top-down; the texture's run bottom-up.
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const target = texture.image.data as Uint8Array;
    const row = WIDTH * 4;
    for (let y = 0; y < HEIGHT; y += 1) {
      target.set(pixels.subarray(y * row, (y + 1) * row), (HEIGHT - 1 - y) * row);
    }
    texture.needsUpdate = true;
  };

  useFrame(({ camera }) => {
    const now = performance.now();
    const c = counter.current;
    c.frames += 1;
    c.worstMs = Math.max(c.worstMs, now - c.last);
    c.last = now;
    if (now - c.since >= UPDATE_MS) {
      draw((c.frames * 1000) / (now - c.since), (now - c.since) / c.frames, c.worstMs);
      c.frames = 0;
      c.worstMs = 0;
      c.since = now;
    }

    // Top-left corner of the view, DISTANCE in front of the camera.
    const node = group.current;
    if (!node) return;
    const perspective = camera as THREE.PerspectiveCamera;
    const halfHeight = DISTANCE * Math.tan(THREE.MathUtils.degToRad(perspective.fov ?? 75) / 2);
    const halfWidth = halfHeight * (size.width / Math.max(1, size.height));
    const height = 2 * halfHeight * SCREEN_HEIGHT;
    const width = height * (WIDTH / HEIGHT);
    const margin = 2 * halfHeight * MARGIN;
    node.position.copy(camera.position);
    node.quaternion.copy(camera.quaternion);
    node.translateZ(-DISTANCE);
    node.translateX(-halfWidth + margin + width / 2);
    node.translateY(halfHeight - margin - height / 2);
    node.scale.set(width, height, 1);
  });

  void canvas;
  return (
    <group ref={group}>
      <mesh renderOrder={1001} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} fog={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
