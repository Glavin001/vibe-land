import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type EditorTool = 'select' | 'terrain';

/**
 * Blender-style camera controls for the Godmode editor.
 *
 * Mouse (all modes):
 *   MMB drag  → orbit
 *   RMB drag  → pan
 *   Scroll    → zoom
 *
 * Keyboard — Arrow keys work in EVERY mode (no shortcut conflicts):
 *   ↑ ↓ ← →   → pan camera
 *
 * Keyboard — WASD/Q/E work in terrain mode only
 * (W/E/R are transform shortcuts in select mode):
 *   WASD      → pan camera on the XZ plane
 *   Q / E     → move camera down / up
 *
 * Orbit retarget:
 *   Alt+Click → snap orbit pivot to clicked world point
 *   Alt+hover → yellow ring previews where pivot will snap
 */
export function GodModeCameraControls({ tool }: { tool: EditorTool }) {
  const { camera, gl, scene } = useThree();
  const keysHeld = useRef(new Set<string>());

  // Callback ref — guaranteed synchronous assignment when OrbitControls mounts.
  const orbitRef = useRef<any>(null);
  const setOrbitRef = useCallback((instance: any) => {
    orbitRef.current = instance;
  }, []);

  // Private raycaster so we never touch R3F's internal one.
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  // Indicator mesh refs
  const pivotRef = useRef<THREE.Mesh>(null);
  const hoverRef = useRef<THREE.Mesh>(null);
  const altHoverPoint = useRef<THREE.Vector3 | null>(null);

  // ── Context menu suppression ─────────────────────────────────────────────────
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    gl.domElement.addEventListener('contextmenu', prevent);
    return () => gl.domElement.removeEventListener('contextmenu', prevent);
  }, [gl]);

  // ── Alt+hover + Alt+Click orbit retarget ────────────────────────────────────
  useEffect(() => {
    const canvas = gl.domElement;

    const hit = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const r = canvas.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((clientX - r.left) / r.width) * 2 - 1,
          -((clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hits = raycaster
        .intersectObjects(scene.children, true)
        .filter(h => !h.object.userData.isOrbitIndicator);
      return hits.length > 0 ? hits[0].point.clone() : null;
    };

    const onMove = (e: PointerEvent) => {
      altHoverPoint.current = e.altKey ? hit(e.clientX, e.clientY) : null;
    };
    const onDown = (e: PointerEvent) => {
      if (!e.altKey || e.button !== 0) return;
      const pt = hit(e.clientX, e.clientY);
      if (pt && orbitRef.current?.target) {
        orbitRef.current.target.copy(pt);
        orbitRef.current.update();
      }
      altHoverPoint.current = null;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altHoverPoint.current = null;
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gl, camera, scene, raycaster]);

  // ── Key tracking ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      ) return;
      // Prevent arrow keys from scrolling the page
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      keysHeld.current.add(e.code);
    };
    const up = (e: KeyboardEvent) => keysHeld.current.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ── Per-frame: indicators + camera movement ─────────────────────────────────
  // Priority 1 = runs AFTER OrbitControls (Drei uses priority -1).
  // We do NOT call controls.update() — we let Drei's own frame handle it on
  // the next tick. This avoids double-update conflicts with damping/panOffset.
  useFrame((state, delta) => {
    // Prefer callback ref; fall back to the makeDefault-registered controls.
    const controls = orbitRef.current ?? (state.controls as any);

    // ── Indicator updates ──
    if (controls?.target) {
      const dist = camera.position.distanceTo(controls.target);
      const s = Math.max(dist * 0.035, 0.4);
      if (pivotRef.current) {
        pivotRef.current.position.copy(controls.target);
        pivotRef.current.scale.setScalar(s);
      }
      const hp = altHoverPoint.current;
      if (hoverRef.current) {
        if (hp) {
          hoverRef.current.position.copy(hp);
          hoverRef.current.scale.setScalar(s);
          hoverRef.current.visible = true;
        } else {
          hoverRef.current.visible = false;
        }
      }
    }

    // ── Camera movement ──
    const keys = keysHeld.current;
    if (keys.size === 0) return;

    const height = Math.max(camera.position.y, 5);
    const speed = height * 0.8 * Math.min(delta, 0.1);

    // Camera-relative XZ forward direction. If looking straight down, fall back
    // to using the camera's Y-axis rotation to infer forward.
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.001) {
      forward.set(-Math.sin(camera.rotation.y), 0, -Math.cos(camera.rotation.y));
    }
    forward.normalize();
    const right = new THREE.Vector3()
      .crossVectors(forward, new THREE.Vector3(0, 1, 0))
      .normalize();

    const move = new THREE.Vector3();

    // Arrow keys — conflict-free in ALL modes ↑↓←→
    if (keys.has('ArrowUp'))    move.addScaledVector(forward, speed);
    if (keys.has('ArrowDown'))  move.addScaledVector(forward, -speed);
    if (keys.has('ArrowLeft'))  move.addScaledVector(right, -speed);
    if (keys.has('ArrowRight')) move.addScaledVector(right, speed);

    // WASD + Q/E — terrain mode only (W→translate, E→rotate in select mode)
    if (tool === 'terrain') {
      if (keys.has('KeyW')) move.addScaledVector(forward, speed);
      if (keys.has('KeyS')) move.addScaledVector(forward, -speed);
      if (keys.has('KeyA')) move.addScaledVector(right, -speed);
      if (keys.has('KeyD')) move.addScaledVector(right, speed);
      if (keys.has('KeyQ')) move.y -= speed;
      if (keys.has('KeyE')) move.y += speed;
    }

    if (move.lengthSq() === 0) return;

    // Translate camera + orbit target together so OrbitControls doesn't
    // snap the camera back on its next update.
    camera.position.add(move);
    if (controls?.target) controls.target.add(move);
  }, 1);

  return (
    <>
      <OrbitControls
        ref={setOrbitRef}
        makeDefault
        enableDamping={false}
        maxDistance={180}
        mouseButtons={{
          LEFT: undefined,
          MIDDLE: THREE.MOUSE.ROTATE,
          RIGHT: THREE.MOUSE.PAN,
        }}
      />

      {/* Current orbit pivot — cyan ring */}
      <mesh
        ref={pivotRef}
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

      {/* Alt+hover preview — yellow ring */}
      <mesh
        ref={hoverRef}
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
