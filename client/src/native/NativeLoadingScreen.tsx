// The native app's loading screen (it has no DOM): a full-view panel in the
// screen-space overlay (NativeOverlay) until the shader warmup is done
// (scene/ShaderWarmup.tsx), so the
// city streaming in and the warmup's compiles happen behind it rather than as
// hitches in play. The scene keeps rendering underneath: that rendering is
// what builds the shaders.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { useShaderWarmupPhase } from '../scene/ShaderWarmup';
import { useOverlaySize } from './NativeOverlay';

const WIDTH = 1024;
const HEIGHT = 512;

export function NativeLoadingScreen() {
  const phase = useShaderWarmupPhase();
  const size = useOverlaySize();
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#10161d';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#e8edf2';
    ctx.font = '56px Menlo, monospace';
    ctx.fillText('vibe-land', 64, HEIGHT / 2 - 10);
    ctx.font = '26px Menlo, monospace';
    ctx.fillStyle = '#9aa7b4';
    ctx.fillText('Loading the city and preparing graphics...', 64, HEIGHT / 2 + 48);
    // getImageData rows run top-down; the texture's run bottom-up.
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const data = new Uint8Array(WIDTH * HEIGHT * 4);
    const row = WIDTH * 4;
    for (let y = 0; y < HEIGHT; y += 1) data.set(pixels.subarray(y * row, (y + 1) * row), (HEIGHT - 1 - y) * row);
    const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    // Covers the whole view; the text's aspect is kept by cropping the backdrop.
    <group visible={phase !== 'done'} scale={[Math.max(size.width, 2 * size.height), size.height, 1]}>
      <mesh renderOrder={2000} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} depthTest={false} depthWrite={false} fog={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
