// The native app's screen-space HUD (it has no DOM): the crosshair, the FPS
// panel and the loading screen, laid out in pixels with the origin at the
// view's centre, +x right and +y up (useOverlaySize gives the view's size).
//
// It is a child of the camera, a fixed distance in front of it, so its pose is
// resolved from the camera's when the frame is rendered. It used to copy the
// camera's pose in a frame callback; the game moves the camera later in the
// same frame, so the HUD was drawn where the camera had been and shook with
// every movement and look. (A separate overlay render pass would also avoid
// that, but mystral presents on every render to the canvas, so a second pass
// costs a second vsync: 30 FPS.)

import { createPortal, useFrame, useThree } from '@react-three/fiber';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import * as THREE from 'three';

import { nativeHud } from './nativeHud';

const OverlaySize = createContext({ width: 1, height: 1 });

/** The view's size in pixels, for children of NativeOverlay. */
export function useOverlaySize(): { width: number; height: number } {
  return useContext(OverlaySize);
}

/** In front of the near plane, behind everything in the world. */
const DISTANCE = 0.5;

/** Nothing in the HUD may be hit by a ray cast through the scene (the crosshair sits on the aim ray). */
const noRaycast = () => {};

export function NativeOverlay({ children }: { children: ReactNode }) {
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const root = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'native HUD';
    group.position.set(0, 0, -DISTANCE);
    return group;
  }, []);

  // The camera has to be in the scene for its children to be drawn.
  useEffect(() => {
    const added = camera.parent === null;
    if (added) scene.add(camera);
    camera.add(root);
    return () => {
      camera.remove(root);
      if (added) scene.remove(camera);
    };
  }, [scene, camera, root]);

  useFrame(() => {
    root.visible = nativeHud.visible;
    // One pixel, in metres at DISTANCE.
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 75;
    const pixel = (2 * DISTANCE * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(1, size.height);
    root.scale.setScalar(pixel);
    root.traverse((object) => {
      object.frustumCulled = false;
      object.raycast = noRaycast;
    });
  });

  const overlaySize = useMemo(() => ({ width: size.width, height: size.height }), [size.width, size.height]);
  return createPortal(
    <OverlaySize.Provider value={overlaySize}>{children}</OverlaySize.Provider>,
    root,
  );
}
