import { useEffect, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GuestCameraMap } from './PracticeGuestPlayer';

interface SplitScreenRendererProps {
  /** Ordered slot ids to render as guest viewports (slotId >= 1). */
  guestSlotIds: number[];
  /** Ordered human ids matching `guestSlotIds` 1:1. */
  guestHumanIds: number[];
  guestCamerasRef: RefObject<GuestCameraMap>;
}

type Viewport = { x: number; y: number; w: number; h: number };

/**
 * Computes per-slot OpenGL-style (bottom-left origin) viewport rectangles
 * for 2..4 local human players. Slot 0 is always the primary viewport,
 * guests follow in slot-id order.
 *
 * - 2 players → 50/50 horizontal split
 * - 3 players → 2x2 with the bottom-right quadrant left blank
 * - 4 players → 2x2 full grid
 */
export function computeSplitScreenViewports(playerCount: number, width: number, height: number): Viewport[] {
  if (playerCount <= 1) return [{ x: 0, y: 0, w: width, h: height }];
  if (playerCount === 2) {
    const hw = Math.floor(width / 2);
    return [
      { x: 0, y: 0, w: hw, h: height },
      { x: hw, y: 0, w: width - hw, h: height },
    ];
  }
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);
  const top = height - hh;
  const cells: Viewport[] = [
    { x: 0, y: top, w: hw, h: hh },
    { x: hw, y: top, w: width - hw, h: hh },
    { x: 0, y: 0, w: hw, h: height - hh },
    { x: hw, y: 0, w: width - hw, h: height - hh },
  ];
  return cells.slice(0, playerCount);
}

/**
 * Takes over the r3f render loop (priority > 0 disables the automatic
 * render pass) and draws the scene once per local-human player into a
 * scissored viewport. The primary player uses the default r3f camera;
 * each guest slot uses its own camera registered in `guestCamerasRef`.
 *
 * This component is only rendered when there is at least one guest.
 */
export function SplitScreenRenderer({
  guestSlotIds,
  guestHumanIds,
  guestCamerasRef,
}: SplitScreenRendererProps) {
  const { gl, scene, camera: defaultCamera, size } = useThree();

  useEffect(() => {
    return () => {
      // Restore default viewport/scissor state when this component unmounts so
      // r3f's auto-render takes over cleanly for single-player mode.
      const sz = new THREE.Vector2();
      gl.getSize(sz);
      gl.setScissorTest(false);
      gl.setViewport(0, 0, sz.x, sz.y);
      gl.setScissor(0, 0, sz.x, sz.y);
    };
  }, [gl]);

  useFrame(() => {
    const camerasMap = guestCamerasRef.current;
    // `gl.setViewport` / `gl.setScissor` in Three.js internally multiply
    // their arguments by the renderer's pixel ratio (see WebGLRenderer.
    // setViewport), so we pass them in CSS pixels. `size.width/height`
    // from r3f are already in CSS pixels.
    const fullW = Math.max(1, Math.round(size.width));
    const fullH = Math.max(1, Math.round(size.height));
    const playerCount = 1 + guestSlotIds.length;
    const viewports = computeSplitScreenViewports(playerCount, fullW, fullH);

    // Clear the whole canvas once so unused viewport regions (e.g. the
    // 4th quadrant in 3-player mode) don't show stale pixels.
    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    gl.setScissor(0, 0, fullW, fullH);
    gl.clear();

    gl.setScissorTest(true);

    for (let i = 0; i < viewports.length; i += 1) {
      const vp = viewports[i];
      if (vp.w <= 0 || vp.h <= 0) continue;
      const cam = i === 0
        ? defaultCamera
        : (() => {
            const humanId = guestHumanIds[i - 1];
            return camerasMap?.get(humanId) ?? null;
          })();
      if (!cam) continue;
      if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const perspective = cam as THREE.PerspectiveCamera;
        const aspect = vp.w / Math.max(vp.h, 1);
        if (Math.abs(perspective.aspect - aspect) > 1e-3) {
          perspective.aspect = aspect;
          perspective.updateProjectionMatrix();
        }
      }
      gl.setViewport(vp.x, vp.y, vp.w, vp.h);
      gl.setScissor(vp.x, vp.y, vp.w, vp.h);
      gl.render(scene, cam);
    }

    gl.setScissorTest(false);
    gl.setViewport(0, 0, fullW, fullH);
    gl.setScissor(0, 0, fullW, fullH);
  }, 1);

  return null;
}
