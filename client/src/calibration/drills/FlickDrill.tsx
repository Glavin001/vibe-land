// Flick drill: six targets appear one at a time at fixed yaw offsets around
// the player. The drill detects a "fire" (mouse left-click or gamepad right
// trigger transition) and counts a hit if the crosshair is within ~1.2° of
// the current target at fire time. Designed to test large-angle accuracy —
// the primary signal for sensitivity and stick-look-speed knobs.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { DrillKind, DrillProps, DrillResult } from './drillTypes';

const DRILL_TIMEOUT_MS = 15_000;
const HIT_ANGLE_RAD = 0.0262; // ~1.5 degrees
const TARGET_DISTANCE = 12;
const TARGET_RADIUS = 0.55;

// Horizontal-only flicks are centered on eye level.
const HORIZONTAL_OFFSETS_DEG = [-25, 35, -15, 55, -45, 20];

// Vertical-biased flicks: targets placed at fixed world-Y offsets ABOVE the
// anchor's eye height (all positive, guaranteed above ground regardless of
// terrain). Paired with smaller horizontal offsets so the drill actually
// exercises vertical aim.
const VERTICAL_YAW_OFFSETS_DEG = [-10, 18, -20, 25, -5, 12];
const VERTICAL_Y_OFFSETS_M = [1.4, 3.2, 0.8, 4.0, 2.2, 2.6];

type TargetPose = {
  yawOffset: number;
  // For horizontal: pitchOffset is used with the direction formula.
  // For vertical: yOffset (meters above anchor eye height) is used directly.
  pitchOffset: number;
  yOffset: number;
  isVertical: boolean;
};

function buildTargets(kind: DrillKind, seed: number): TargetPose[] {
  const poses: TargetPose[] = kind === 'flickVertical'
    ? VERTICAL_YAW_OFFSETS_DEG.map((deg, i) => ({
        yawOffset: THREE.MathUtils.degToRad(deg),
        pitchOffset: 0,
        yOffset: VERTICAL_Y_OFFSETS_M[i] ?? 2.0,
        isVertical: true,
      }))
    : HORIZONTAL_OFFSETS_DEG.map((deg) => ({
        yawOffset: THREE.MathUtils.degToRad(deg),
        pitchOffset: 0,
        yOffset: 0,
        isVertical: false,
      }));

  // Cheap seed-driven shuffle so successive runs aren't identical but each
  // run is reproducible given its seed (not used for correctness, only as a
  // fallback if we ever want A and B to see the same target order).
  const rng = mulberry32(seed);
  for (let i = poses.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = poses[i];
    poses[i] = poses[j];
    poses[j] = tmp;
  }
  return poses;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_TARGETS = HORIZONTAL_OFFSETS_DEG.length; // always 6 for both modes

function scoreFlick(hits: number, attempts: number, totalTimeMs: number): number {
  if (attempts === 0) return 0;
  const misses = Math.max(0, attempts - hits);
  const meanSec = Math.max(0.3, totalTimeMs / 1000 / Math.max(1, hits));
  const raw = hits / (1 + misses) - 0.1 * meanSec;
  return Math.max(0, Math.min(1, raw / TOTAL_TARGETS + 0.5 * (hits / TOTAL_TARGETS)));
}

type FlickDrillProps = DrillProps & { kind: 'flick' | 'flickVertical' };

export function FlickDrill({ runKey, running, onComplete, kind }: FlickDrillProps) {
  const { camera } = useThree();

  // Stable per-run state anchored to camera pose at first `running=true`.
  const anchorRef = useRef<{
    position: THREE.Vector3;
    yaw: number;
    targets: THREE.Vector3[];
    poses: TargetPose[];
  } | null>(null);
  const stateRef = useRef({
    index: 0,
    hits: 0,
    attempts: 0,
    startMs: 0,
    completed: false,
  });
  const [tick, setTick] = useState(0); // forces re-render when index changes

  // Reset everything when runKey changes.
  useEffect(() => {
    anchorRef.current = null;
    stateRef.current = { index: 0, hits: 0, attempts: 0, startMs: 0, completed: false };
    setTick((t) => t + 1);
  }, [runKey]);

  // Fire detection (mouse + gamepad RT edge).
  const prevRtRef = useRef(false);
  useEffect(() => {
    if (!running) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      handleFire();
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  function finish(finalTimeMs: number) {
    if (stateRef.current.completed) return;
    stateRef.current.completed = true;
    const { hits, attempts } = stateRef.current;
    const result: DrillResult = {
      kind,
      hits,
      attempts,
      totalTimeMs: finalTimeMs,
      score: scoreFlick(hits, attempts, finalTimeMs),
    };
    onComplete(result);
  }

  function handleFire() {
    if (!running || !anchorRef.current || stateRef.current.completed) return;
    const state = stateRef.current;
    state.attempts += 1;
    const pose = anchorRef.current.poses[state.index];
    if (!pose) return;
    // Angular distance between camera forward and vector to current target.
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const target = anchorRef.current.targets[state.index];
    const toTarget = target.clone().sub(camera.position).normalize();
    const dot = Math.min(1, Math.max(-1, fwd.dot(toTarget)));
    const angle = Math.acos(dot);
    if (angle <= HIT_ANGLE_RAD) {
      state.hits += 1;
      state.index += 1;
      setTick((t) => t + 1);
      if (state.index >= HORIZONTAL_OFFSETS_DEG.length) {
        finish(performance.now() - state.startMs);
      }
    }
  }

  useFrame(() => {
    if (!running) return;

    // Lazy-initialize the anchor from the current camera pose.
    if (!anchorRef.current) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      const baseYaw = Math.atan2(-fwd.x, -fwd.z);
      const poses = buildTargets(kind, Math.floor(runKey));
      const anchorPos = camera.position.clone();
      const targets = poses.map((p) => {
        const yaw = baseYaw + p.yawOffset;
        if (p.isVertical) {
          // Horizontal direction only; vertical component comes from yOffset
          // (world meters above anchor eye height). Guarantees the target is
          // above ground regardless of terrain.
          const horiz = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
          return anchorPos.clone()
            .addScaledVector(horiz, TARGET_DISTANCE)
            .add(new THREE.Vector3(0, p.yOffset, 0));
        }
        const pitch = p.pitchOffset;
        const v = new THREE.Vector3(
          -Math.sin(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          -Math.cos(yaw) * Math.cos(pitch),
        );
        return anchorPos.clone().addScaledVector(v, TARGET_DISTANCE);
      });
      anchorRef.current = { position: anchorPos, yaw: baseYaw, targets, poses };
      stateRef.current.startMs = performance.now();
      setTick((t) => t + 1);
    }

    // Gamepad RT edge detection.
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p) => p && p.connected) ?? null;
    const rt = pad?.buttons?.[7]?.value ?? 0;
    const pressed = rt > 0.35;
    if (pressed && !prevRtRef.current) {
      handleFire();
    }
    prevRtRef.current = pressed;

    // Timeout.
    if (!stateRef.current.completed && stateRef.current.startMs > 0) {
      const elapsed = performance.now() - stateRef.current.startMs;
      if (elapsed >= DRILL_TIMEOUT_MS) {
        finish(elapsed);
      }
    }
  });

  const anchor = anchorRef.current;
  const currentIndex = stateRef.current.index;
  const activeMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#ff5a3c', emissive: '#ff4010', emissiveIntensity: 1.6 }),
    [],
  );
  const haloMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#ffb070',
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      depthTest: false,
    }),
    [],
  );
  const dimMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({
      color: '#3a4656',
      emissive: '#1a2230',
      emissiveIntensity: 0.2,
      transparent: true,
      opacity: 0.5,
    }),
    [],
  );

  if (!anchor) return null;
  // Force re-evaluation when tick changes.
  void tick;
  return (
    <group>
      {anchor.targets.map((pos, i) => {
        const isCurrent = i === currentIndex;
        const isUpcoming = i > currentIndex;
        if (!isCurrent && !isUpcoming) return null;
        if (isCurrent) {
          return (
            <group key={i} position={[pos.x, pos.y, pos.z]}>
              {/* Depth-disabled halo so the target is visible even through
                  terrain or props — no more losing sight of it. */}
              <mesh material={haloMaterial} renderOrder={999}>
                <sphereGeometry args={[TARGET_RADIUS * 2.1, 20, 16]} />
              </mesh>
              <mesh material={activeMaterial}>
                <sphereGeometry args={[TARGET_RADIUS, 24, 20]} />
              </mesh>
            </group>
          );
        }
        return (
          <mesh key={i} position={[pos.x, pos.y, pos.z]} material={dimMaterial}>
            <sphereGeometry args={[TARGET_RADIUS * 0.9, 16, 12]} />
          </mesh>
        );
      })}
    </group>
  );
}
