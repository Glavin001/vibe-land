// The current weapon in the native app's overlay (NativeOverlay), bottom
// right: the web client's ui/WeaponHud.tsx, drawn on a 2D canvas (mystral's
// Skia) into a texture whenever the weapon changes.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { SHOT_MODE_LABELS, SHOT_MODES } from '../city/shotMode';
import { useShotMode } from '../city/useShotMode';
import { useOverlaySize } from './NativeOverlay';

const WIDTH = 512;
const HEIGHT = 128;
/** On-screen height of the panel, as a fraction of the view height. */
const SCREEN_HEIGHT = 0.1;
const MARGIN = 0.02;

export function NativeWeaponHud() {
  const size = useOverlaySize();
  const current = useShotMode();
  const { ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const texture = new THREE.DataTexture(new Uint8Array(WIDTH * HEIGHT * 4), WIDTH, HEIGHT, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { ctx, texture };
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  useEffect(() => {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(8, 12, 18, 0.55)';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textAlign = 'right';
    ctx.font = 'bold 44px Menlo, monospace';
    ctx.fillStyle = '#e8edf2';
    ctx.fillText(SHOT_MODE_LABELS[current].toUpperCase(), WIDTH - 16, 52);
    // The slots, right-aligned, the current one highlighted.
    ctx.font = '22px Menlo, monospace';
    let x = WIDTH - 16;
    for (let i = SHOT_MODES.length - 1; i >= 0; i -= 1) {
      const mode = SHOT_MODES[i];
      const text = `${i + 1} ${SHOT_MODE_LABELS[mode]}`;
      ctx.fillStyle = mode === current ? '#ffd166' : '#8b96a2';
      ctx.fillText(text, x, 88);
      x -= ctx.measureText(text).width + 20;
    }
    ctx.font = '17px Menlo, monospace';
    ctx.fillStyle = '#8b96a2';
    ctx.fillText(`scroll or 1-${SHOT_MODES.length} to switch`, WIDTH - 16, 116);
    // getImageData rows run top-down; the texture's run bottom-up.
    const pixels = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const target = texture.image.data as Uint8Array;
    const row = WIDTH * 4;
    for (let y = 0; y < HEIGHT; y += 1) target.set(pixels.subarray(y * row, (y + 1) * row), (HEIGHT - 1 - y) * row);
    texture.needsUpdate = true;
  }, [ctx, texture, current]);

  // The view's bottom-right corner, in overlay pixels (origin at the centre).
  const height = size.height * SCREEN_HEIGHT;
  const width = height * (WIDTH / HEIGHT);
  const margin = size.height * MARGIN;
  return (
    <group position={[size.width / 2 - margin - width / 2, -size.height / 2 + margin + height / 2, 0]} scale={[width, height, 1]}>
      <mesh renderOrder={1001} frustumCulled={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} fog={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
