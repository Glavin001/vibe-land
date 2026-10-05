// Frames per second, drawn in the scene's top-left corner (the native app
// has no DOM). Text is rasterised on a small 2D canvas (mystral's Skia), read
// back with getImageData into a DataTexture twice a second, and shown on a
// quad kept in front of the camera, over everything.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

const WIDTH = 256;
const HEIGHT = 48;
const UPDATE_MS = 500;
const DISTANCE = 0.5;
/** On-screen height of the panel, as a fraction of the view height. */
const SCREEN_HEIGHT = 0.045;
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

  const draw = (fps: number, worstMs: number) => {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.font = 'bold 28px Menlo, monospace';
    ctx.fillStyle = fps >= 55 ? '#7CFC8A' : fps >= 30 ? '#FFD166' : '#FF6B6B';
    ctx.fillText(`${fps.toFixed(0)} FPS`, 10, 33);
    ctx.font = '16px Menlo, monospace';
    ctx.fillStyle = '#d0d4d8';
    ctx.fillText(`max ${worstMs.toFixed(1)} ms`, 140, 31);
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
      draw((c.frames * 1000) / (now - c.since), c.worstMs);
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
