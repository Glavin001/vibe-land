import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type EditorTool = 'select' | 'terrain';

// Shape of the Three.js OrbitControls instance we care about
type OC = { target: THREE.Vector3; update(): void };

/**
 * Blender-style camera controls for the Godmode editor:
 *
 *   MMB drag  → orbit  (works in ALL editor tools, no mode switching)
 *   RMB drag  → pan
 *   Scroll    → zoom
 *   WASD      → pan camera on XZ plane   (terrain mode only)
 *   Q / E     → move camera down / up    (terrain mode only)
 *
 *   Alt + hover → yellow ring previews where orbit pivot will snap to
 *   Alt + LMB   → snap orbit pivot to the hovered world point
 *
 * Left-click is always free for terrain painting and object selection.
 */
export function GodModeCameraControls({ tool }: { tool: EditorTool }) {
  const { camera, gl, scene, raycaster } = useThree();
  const keysHeld = useRef(new Set<string>());

  // Reference to the underlying Three.js OrbitControls instance.
  // Synced from state.controls in useFrame so it's always up-to-date.
  const controlsRef = useRef<OC | null>(null);

  // Indicator mesh refs
  const pivotIndicatorRef = useRef<THREE.Mesh>(null);
  const hoverIndicatorRef = useRef<THREE.Mesh>(null);

  // Alt-hover world position (set by mousemove, cleared when Alt released)
  const altHoverPoint = useRef<THREE.Vector3 | null>(null);

  // ── Context menu suppression ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = gl.domElement;
    const prevent = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', prevent);
    return () => canvas.removeEventListener('contextmenu', prevent);
  }, [gl]);

  // ── Alt+hover preview + Alt+Click to set orbit pivot ────────────────────────
  useEffect(() => {
    const canvas = gl.domElement;

    const getRaycastHit = (e: MouseEvent): THREE.Vector3 | null => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // Exclude our own indicator meshes so Alt+Click can't target them
      const hits = raycaster
        .intersectObjects(scene.children, true)
        .filter(h => !h.object.userData.isOrbitIndicator);
      return hits.length > 0 ? hits[0].point.clone() : null;
    };

    const onMouseMove = (e: MouseEvent) => {
      altHoverPoint.current = e.altKey ? getRaycastHit(e) : null;
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!e.altKey || e.button !== 0) return;
      // Prevent the browser from doing anything (e.g. text selection)
      e.preventDefault();
      const point = getRaycastHit(e);
      const controls = controlsRef.current;
      if (point && controls) {
        controls.target.copy(point);
        controls.update();
      }
      altHoverPoint.current = null;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altHoverPoint.current = null;
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gl, camera, scene, raycaster]);

  // ── WASD keyboard movement (terrain mode only) ──────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      ) return;
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

  // ── Frame loop: sync controls ref, update indicators, run WASD ──────────────
  useFrame((state, delta) => {
    // Keep controlsRef current via state.controls (registered by makeDefault)
    const oc = state.controls as OC | null;
    if (oc && oc !== controlsRef.current) controlsRef.current = oc;

    // Scale indicators with camera distance so they read consistently at any zoom
    const dist = oc ? camera.position.distanceTo(oc.target) : 0;
    const s = Math.max(dist * 0.035, 0.4);

    // Orbit pivot indicator — always shows the current orbit center
    if (pivotIndicatorRef.current && oc?.target) {
      pivotIndicatorRef.current.position.copy(oc.target);
      pivotIndicatorRef.current.scale.setScalar(s);
    }

    // Alt-hover indicator — shows where the pivot will snap on Alt+Click
    if (hoverIndicatorRef.current) {
      const hp = altHoverPoint.current;
      if (hp) {
        hoverIndicatorRef.current.position.copy(hp);
        hoverIndicatorRef.current.scale.setScalar(s);
        hoverIndicatorRef.current.visible = true;
      } else {
        hoverIndicatorRef.current.visible = false;
      }
    }

    // WASD only in terrain mode — W/E/R are transform shortcuts in select mode
    if (tool !== 'terrain' || !oc) return;
    const keys = keysHeld.current;
    if (keys.size === 0) return;

    // Speed scales with camera height so far-out views pan faster
    const height = Math.max(camera.position.y, 5);
    const speed = height * 0.8 * Math.min(delta, 0.1);

    // Camera-relative XZ directions (ignore vertical tilt)
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

    // Move camera and orbit target together to preserve the orbit relationship
    camera.position.add(move);
    oc.target.add(move);
    oc.update();
  });

  return (
    <>
      <OrbitControls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={controlsRef as any}
        makeDefault
        maxDistance={180}
        mouseButtons={{
          LEFT: undefined,           // free for terrain painting / object selection
          MIDDLE: THREE.MOUSE.ROTATE, // MMB → orbit
          RIGHT: THREE.MOUSE.PAN,    // RMB → pan
        }}
      />

      {/* Current orbit pivot — cyan ring, always visible */}
      <mesh
        ref={pivotIndicatorRef}
        rotation-x={-Math.PI / 2}
        renderOrder={999}
        userData={{ isOrbitIndicator: true }}
      >
        <ringGeometry args={[0.28, 0.44, 32]} />
        <meshBasicMaterial
          color={0x00cfff}
          transparent
          opacity={0.55}
          side={THREE.DoubleSide}
          depthTest={false}
        />
      </mesh>

      {/* Alt+hover preview — yellow ring, only visible while Alt is held over scene */}
      <mesh
        ref={hoverIndicatorRef}
        rotation-x={-Math.PI / 2}
        visible={false}
        renderOrder={1000}
        userData={{ isOrbitIndicator: true }}
      >
        <ringGeometry args={[0.28, 0.44, 32]} />
        <meshBasicMaterial
          color={0xffdd44}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          depthTest={false}
        />
      </mesh>
    </>
  );
}
