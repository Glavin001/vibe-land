import { type MutableRefObject, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type EditorTool = 'select' | 'terrain';

// Minimal interface for the underlying Three.js OrbitControls instance
type OrbitControlsInstance = {
  target: THREE.Vector3;
  update(): void;
};

type Props = {
  tool: EditorTool;
  /**
   * A ref that gets populated with a function to imperatively snap the orbit
   * target to a world-space point. Call this whenever the user left-clicks on
   * the terrain so subsequent MMB orbits pivot around the work area.
   */
  setOrbitTargetRef: MutableRefObject<((point: THREE.Vector3) => void) | null>;
};

/**
 * Blender-style camera controls for the Godmode editor:
 *   - MMB drag → orbit  (works in ALL editor tools, no mode switching required)
 *   - RMB drag → pan
 *   - Scroll   → zoom
 *   - WASD     → camera pan on the XZ plane (terrain mode only)
 *   - Q / E    → camera down / up (terrain mode only)
 *
 * Left-click is intentionally left free so terrain painting and object
 * selection work in every mode without interference.
 */
export function GodModeCameraControls({ tool, setOrbitTargetRef }: Props) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orbitRef = useRef<OrbitControlsInstance | null>(null);
  const { camera, gl } = useThree();
  const keysHeld = useRef(new Set<string>());

  // ── Suppress browser context menu so right-click can pan the camera ─────────
  useEffect(() => {
    const canvas = gl.domElement;
    const prevent = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', prevent);
    return () => canvas.removeEventListener('contextmenu', prevent);
  }, [gl]);

  // ── Expose an imperative setter so parent can snap the orbit pivot ────────────
  useEffect(() => {
    setOrbitTargetRef.current = (point: THREE.Vector3) => {
      const controls = orbitRef.current;
      if (!controls) return;
      controls.target.copy(point);
      controls.update();
    };
    return () => {
      setOrbitTargetRef.current = null;
    };
  }, [setOrbitTargetRef]);

  // ── WASD keyboard movement (terrain mode only to avoid W/E/R transform conflicts) ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      ) {
        return;
      }
      keysHeld.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keysHeld.current.delete(e.code);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useFrame((_, delta) => {
    const controls = orbitRef.current;
    // WASD only in terrain mode — in select mode W/E/R are transform shortcuts
    if (!controls || tool !== 'terrain') return;
    const keys = keysHeld.current;
    if (keys.size === 0) return;

    // Speed proportional to camera height so distant views pan faster
    const height = Math.max(camera.position.y, 5);
    const speed = height * 0.8 * Math.min(delta, 0.1);

    // Camera-relative horizontal directions (ignoring vertical tilt)
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.001) return;
    forward.normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();

    const move = new THREE.Vector3();
    if (keys.has('KeyW')) move.addScaledVector(forward, speed);
    if (keys.has('KeyS')) move.addScaledVector(forward, -speed);
    if (keys.has('KeyA')) move.addScaledVector(right, -speed);
    if (keys.has('KeyD')) move.addScaledVector(right, speed);
    if (keys.has('KeyQ')) move.y -= speed;
    if (keys.has('KeyE')) move.y += speed;

    if (move.lengthSq() === 0) return;

    // Move both camera and target together to preserve the orbit relationship
    camera.position.add(move);
    controls.target.add(move);
    controls.update();
  });

  return (
    <OrbitControls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ref={orbitRef as any}
      makeDefault
      maxDistance={180}
      enableDamping
      dampingFactor={0.08}
      mouseButtons={{
        // Left click is free for terrain painting and object selection (undefined = disabled)
        LEFT: undefined,
        // Middle mouse = orbit (Blender-style)
        MIDDLE: THREE.MOUSE.ROTATE,
        // Right mouse = pan
        RIGHT: THREE.MOUSE.PAN,
      }}
    />
  );
}
