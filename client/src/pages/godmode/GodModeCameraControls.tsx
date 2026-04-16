import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

type EditorTool = 'select' | 'terrain';

/**
 * Blender-style camera controls for the Godmode editor.
 *
 * Mouse (always active, all modes):
 *   MMB drag  → orbit
 *   RMB drag  → pan
 *   Scroll    → zoom
 *
 * Keyboard (terrain mode only — avoids W/E/R transform conflicts):
 *   WASD      → pan camera on the XZ plane
 *   Q / E     → move camera down / up
 *
 * Orbit retarget:
 *   Alt+Click → snap orbit pivot to clicked point (cyan → yellow preview)
 */
export function GodModeCameraControls({ tool }: { tool: EditorTool }) {
  const { camera, gl, scene } = useThree();
  const keysHeld = useRef(new Set<string>());

  // Separate ref populated via callback ref — guaranteed to be set on mount.
  const orbitControlsRef = useRef<any>(null);
  const handleOrbitRef = useCallback((instance: any) => {
    orbitControlsRef.current = instance;
  }, []);

  // Own raycaster (never touch R3F's internal one — corrupting it breaks all events)
  const myRaycaster = useMemo(() => new THREE.Raycaster(), []);

  // Indicator mesh refs
  const pivotRef = useRef<THREE.Mesh>(null);
  const hoverRef = useRef<THREE.Mesh>(null);
  const altHoverPoint = useRef<THREE.Vector3 | null>(null);

  // ── Suppress browser context menu on the canvas ─────────────────────────────
  useEffect(() => {
    const canvas = gl.domElement;
    const prevent = (e: Event) => e.preventDefault();
    canvas.addEventListener('contextmenu', prevent);
    return () => canvas.removeEventListener('contextmenu', prevent);
  }, [gl]);

  // ── Alt+hover preview  +  Alt+Click to set orbit pivot ──────────────────────
  useEffect(() => {
    const canvas = gl.domElement;

    const raycastHit = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      myRaycaster.setFromCamera(ndc, camera);
      const hits = myRaycaster
        .intersectObjects(scene.children, true)
        .filter(h => !h.object.userData.isOrbitIndicator);
      return hits.length > 0 ? hits[0].point.clone() : null;
    };

    const onPointerMove = (e: PointerEvent) => {
      altHoverPoint.current = e.altKey ? raycastHit(e.clientX, e.clientY) : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!e.altKey || e.button !== 0) return;
      const point = raycastHit(e.clientX, e.clientY);
      const controls = orbitControlsRef.current;
      if (point && controls?.target) {
        controls.target.copy(point);
        controls.update();
      }
      altHoverPoint.current = null;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') altHoverPoint.current = null;
    };

    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gl, camera, scene, myRaycaster]);

  // ── WASD key tracking ──────────────────────────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'INPUT' ||
          e.target.tagName === 'TEXTAREA' ||
          e.target.isContentEditable)
      ) return;
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

  // ── Per-frame: indicators + WASD movement ──────────────────────────────────
  useFrame((_, delta) => {
    const controls = orbitControlsRef.current;
    if (!controls?.target) return;

    // Sync pivot indicator to current orbit center
    const dist = camera.position.distanceTo(controls.target);
    const s = Math.max(dist * 0.035, 0.4);
    if (pivotRef.current) {
      pivotRef.current.position.copy(controls.target);
      pivotRef.current.scale.setScalar(s);
    }

    // Sync hover indicator to Alt-hover hit
    if (hoverRef.current) {
      const hp = altHoverPoint.current;
      if (hp) {
        hoverRef.current.position.copy(hp);
        hoverRef.current.scale.setScalar(s);
        hoverRef.current.visible = true;
      } else {
        hoverRef.current.visible = false;
      }
    }

    // WASD camera movement — terrain mode only (W/E/R conflict in select mode)
    if (tool !== 'terrain') return;
    const keys = keysHeld.current;
    if (keys.size === 0) return;

    const height = Math.max(camera.position.y, 5);
    const speed = height * 0.8 * Math.min(delta, 0.1);

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

    // Move camera and orbit target together so OrbitControls doesn't fight back
    camera.position.add(move);
    controls.target.add(move);
    controls.update();
  });

  return (
    <>
      <OrbitControls
        ref={handleOrbitRef}
        makeDefault
        enableDamping={false}
        maxDistance={180}
        mouseButtons={{
          LEFT: undefined,
          MIDDLE: THREE.MOUSE.ROTATE,
          RIGHT: THREE.MOUSE.PAN,
        }}
      />

      {/* Current orbit pivot — small cyan ring */}
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

      {/* Alt+hover preview — yellow ring, only while Alt is held */}
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
