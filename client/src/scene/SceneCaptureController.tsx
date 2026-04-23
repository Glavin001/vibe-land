import { useEffect, type MutableRefObject } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

export type ResolvedCaptureConfig = {
  position: [number, number, number];
  target: [number, number, number];
  type: 'perspective' | 'orthographic';
  fov: number;
  orthoWidth: number;
  width: number;
  height: number;
};

export type CaptureFunction = (config: ResolvedCaptureConfig) => Promise<string>;

/**
 * Mounts inside the Three.js Canvas. Populates captureRef.current with an
 * async function that renders the scene offscreen and returns a PNG data URL.
 * The main canvas and camera are never disturbed — rendering goes to a
 * temporary WebGLRenderTarget.
 */
export function SceneCaptureController({
  captureRef,
}: {
  captureRef: MutableRefObject<CaptureFunction | null>;
}) {
  const { gl, scene } = useThree();

  useEffect(() => {
    captureRef.current = async (config: ResolvedCaptureConfig): Promise<string> => {
      const {
        width,
        height,
        type,
        fov,
        orthoWidth,
        position,
        target,
      } = config;

      const aspect = width / height;

      // Build a temporary camera (never added to the scene graph)
      let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
      if (type === 'orthographic') {
        const halfW = orthoWidth / 2;
        const halfH = halfW / aspect;
        camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 10000);
      } else {
        camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 10000);
      }
      camera.position.set(position[0], position[1], position[2]);
      camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
      camera.up.set(0, 1, 0);
      camera.updateMatrixWorld(true);

      // Offscreen render target
      const rt = new THREE.WebGLRenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: true,
      });

      // Render to the render target, preserving the live canvas state
      const prevRenderTarget = gl.getRenderTarget();
      gl.setRenderTarget(rt);
      gl.clear();
      gl.render(scene, camera);

      // Read raw RGBA pixels (WebGL origin is bottom-left)
      const pixelBuffer = new Uint8Array(width * height * 4);
      gl.readRenderTargetPixels(rt, 0, 0, width, height, pixelBuffer);

      // Restore the previous render target
      gl.setRenderTarget(prevRenderTarget);
      rt.dispose();

      // Flip rows: WebGL gives bottom-to-top, but ImageData expects top-to-bottom
      const flipped = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row++) {
        const srcRow = height - 1 - row;
        const srcOffset = srcRow * width * 4;
        const dstOffset = row * width * 4;
        flipped.set(pixelBuffer.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }

      // Encode to PNG via an offscreen 2D canvas
      const canvas2d = document.createElement('canvas');
      canvas2d.width = width;
      canvas2d.height = height;
      const ctx2d = canvas2d.getContext('2d');
      if (!ctx2d) throw new Error('Could not get 2D canvas context for screenshot encoding');
      ctx2d.putImageData(new ImageData(flipped, width, height), 0, 0);
      return canvas2d.toDataURL('image/png');
    };

    return () => {
      captureRef.current = null;
    };
  }, [gl, scene, captureRef]);

  return null;
}
