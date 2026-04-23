import { useEffect, type MutableRefObject } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { isWebGPUBackend } from './createRenderer';

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

export type CapturedCurrentView = {
  dataUrl: string;
  blob: Blob;
  width: number;
  height: number;
};

export type CaptureCurrentViewOptions = {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
};

export type CaptureCurrentViewFunction = (
  options?: CaptureCurrentViewOptions,
) => Promise<CapturedCurrentView>;

const DEFAULT_CURRENT_VIEW_MAX_WIDTH = 960;
const DEFAULT_CURRENT_VIEW_MAX_HEIGHT = 540;
const DEFAULT_CURRENT_VIEW_QUALITY = 0.85;

/**
 * Mounts inside the Three.js Canvas. Populates captureRef.current with an
 * async function that renders the scene offscreen from an explicit camera
 * config and returns a PNG data URL. If captureCurrentViewRef is provided,
 * also exposes a "current view" capture that uses the live scene camera and
 * returns a JPEG data URL + Blob sized for upload.
 *
 * Both paths render to an offscreen render target so they work identically
 * on WebGL2 and WebGPU without relying on `preserveDrawingBuffer`.
 */
export function SceneCaptureController({
  captureRef,
  captureCurrentViewRef,
}: {
  captureRef: MutableRefObject<CaptureFunction | null>;
  captureCurrentViewRef?: MutableRefObject<CaptureCurrentViewFunction | null>;
}) {
  const { gl, scene, camera: liveCamera, size } = useThree();

  useEffect(() => {
    captureRef.current = async (config: ResolvedCaptureConfig): Promise<string> => {
      const { width, height, type, fov, orthoWidth, position, target } = config;
      const aspect = width / height;

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

      const imageData = await renderToImageData(gl, scene, camera, width, height);
      return encodeImageDataToPng(imageData, width, height);
    };

    return () => {
      captureRef.current = null;
    };
  }, [gl, scene, captureRef]);

  useEffect(() => {
    if (!captureCurrentViewRef) return;

    captureCurrentViewRef.current = async (
      options: CaptureCurrentViewOptions = {},
    ): Promise<CapturedCurrentView> => {
      const maxWidth = options.maxWidth ?? DEFAULT_CURRENT_VIEW_MAX_WIDTH;
      const maxHeight = options.maxHeight ?? DEFAULT_CURRENT_VIEW_MAX_HEIGHT;
      const quality = options.quality ?? DEFAULT_CURRENT_VIEW_QUALITY;

      const srcWidth = Math.max(2, Math.round(size.width));
      const srcHeight = Math.max(2, Math.round(size.height));
      if (srcWidth === 0 || srcHeight === 0) {
        throw new Error('Canvas has zero dimensions; nothing to capture.');
      }

      const aspect = srcWidth / srcHeight;
      let width = Math.min(srcWidth, maxWidth);
      let height = Math.round(width / aspect);
      if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * aspect);
      }
      width = Math.max(2, Math.round(width));
      height = Math.max(2, Math.round(height));

      // The live camera's projection is tied to the canvas aspect; keep its
      // world pose but build a fresh camera matching the capture aspect so
      // downsizing to an arbitrary target size doesn't stretch the view.
      const camera = cloneCameraWithAspect(liveCamera, width / height);

      const imageData = await renderToImageData(gl, scene, camera, width, height);
      return encodeImageDataToJpeg(imageData, width, height, quality);
    };

    return () => {
      captureCurrentViewRef.current = null;
    };
  }, [gl, scene, liveCamera, size.width, size.height, captureCurrentViewRef]);

  return null;
}

async function renderToImageData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gl: any,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });

  const prevRenderTarget = gl.getRenderTarget();
  gl.setRenderTarget(rt);
  gl.clear();

  // WebGPURenderer exposes an async render that resolves once the frame is
  // submitted to the GPU. WebGLRenderer is sync; either way we await the
  // submission before reading pixels.
  if (typeof gl.renderAsync === 'function') {
    await gl.renderAsync(scene, camera);
  } else {
    gl.render(scene, camera);
  }

  const pixelBuffer = new Uint8Array(width * height * 4);
  if (typeof gl.readRenderTargetPixelsAsync === 'function') {
    await gl.readRenderTargetPixelsAsync(rt, 0, 0, width, height, pixelBuffer);
  } else {
    gl.readRenderTargetPixels(rt, 0, 0, width, height, pixelBuffer);
  }

  gl.setRenderTarget(prevRenderTarget);
  rt.dispose();

  // WebGL returns pixels bottom-up; WebGPU returns them top-down. Flip only
  // on WebGL so ImageData (top-down) receives them correctly either way.
  // Back the output with an explicit ArrayBuffer so its type is compatible
  // with ImageData's ImageDataArray (rejects SharedArrayBuffer-backed views).
  const out = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  if (!isWebGPUBackend(gl)) {
    for (let row = 0; row < height; row++) {
      const srcRow = height - 1 - row;
      const srcOffset = srcRow * width * 4;
      const dstOffset = row * width * 4;
      out.set(pixelBuffer.subarray(srcOffset, srcOffset + width * 4), dstOffset);
    }
  } else {
    out.set(pixelBuffer);
  }
  return out;
}

function encodeImageDataToPng(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): string {
  const canvas2d = document.createElement('canvas');
  canvas2d.width = width;
  canvas2d.height = height;
  const ctx2d = canvas2d.getContext('2d');
  if (!ctx2d) throw new Error('Could not get 2D canvas context for screenshot encoding');
  ctx2d.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas2d.toDataURL('image/png');
}

async function encodeImageDataToJpeg(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  quality: number,
): Promise<CapturedCurrentView> {
  const canvas2d = document.createElement('canvas');
  canvas2d.width = width;
  canvas2d.height = height;
  const ctx2d = canvas2d.getContext('2d');
  if (!ctx2d) throw new Error('Could not get 2D canvas context for screenshot encoding');
  // Paint a background so any transparent pixels encode as opaque JPEG.
  ctx2d.fillStyle = '#04070d';
  ctx2d.fillRect(0, 0, width, height);
  ctx2d.putImageData(new ImageData(rgba, width, height), 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas2d.toBlob((result) => resolve(result), 'image/jpeg', quality);
  });
  if (!blob) {
    throw new Error('toBlob returned null; screenshot encode failed.');
  }
  const dataUrl = canvas2d.toDataURL('image/jpeg', quality);
  return { blob, dataUrl, width, height };
}

function cloneCameraWithAspect(
  source: THREE.Camera,
  aspect: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  if ((source as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const src = source as THREE.PerspectiveCamera;
    const cam = new THREE.PerspectiveCamera(src.fov, aspect, src.near, src.far);
    cam.position.copy(src.position);
    cam.quaternion.copy(src.quaternion);
    cam.scale.copy(src.scale);
    cam.up.copy(src.up);
    cam.updateMatrixWorld(true);
    return cam;
  }
  if ((source as THREE.OrthographicCamera).isOrthographicCamera) {
    const src = source as THREE.OrthographicCamera;
    // Preserve vertical extent, rescale horizontal to match capture aspect.
    const halfH = (src.top - src.bottom) / 2;
    const halfW = halfH * aspect;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, src.near, src.far);
    cam.position.copy(src.position);
    cam.quaternion.copy(src.quaternion);
    cam.scale.copy(src.scale);
    cam.up.copy(src.up);
    cam.updateMatrixWorld(true);
    return cam;
  }
  // Fallback: best-effort perspective with a sensible FOV.
  const cam = new THREE.PerspectiveCamera(55, aspect, 0.1, 10000);
  cam.position.copy(source.position);
  cam.quaternion.copy(source.quaternion);
  cam.updateMatrixWorld(true);
  return cam;
}
