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
const HIT_ANGLE_RAD = 0.0209; // ~1.2 degrees
const TARGET_DISTANCE = 12;
const TARGET_RADIUS = 0.45;

const HORIZONTAL_OFFSETS_DEG = [-25, 35, -15, 55, -45, 20];
const VERTICAL_BIAS_DEG = [-18, 22, -10, 28, -22, 15];

type TargetPose = { yawOffset: number; pitchOffset: number };

function buildTargets(kind: DrillKind, seed: number): TargetPose[] {
  const horizontal = HORIZONTAL_OFFSETS_DEG.map((deg, i) => ({
    yawOffset: THREE.MathUtils.degToRad(deg),
    pitchOffset: kind === 'flickVertical' ? THREE.MathUtils.degToRad(VERTICAL_BIAS_DEG[i] ?? 0) : 0,
  }));
  // Cheap seed-driven shuffle so successive runs aren't identical but each
  // run is reproducible given its seed (not used for correctness, only as a
  // fallback if we ever want A and B to see the same target order).
  const rng = mulberry32(seed);
  for (let i = horizontal.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = horizontal[i];
    horizontal[i] = horizontal[j];
    horizontal[j] = tmp;
  }
  return horizontal;
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

function scoreFlick(hits: number, attempts: number, totalTimeMs: number): number {
  if (attempts === 0) return 0;
  const misses = Math.max(0, attempts - hits);
  const meanSec = Math.max(0.3, totalTimeMs / 1000 / Math.max(1, hits));
  const raw = hits / (1 + misses) - 0.1 * meanSec;
  const max = HORIZONTAL_OFFSETS_DEG.length; // denominator for normalization
  return Math.max(0, Math.min(1, raw / max + 0.5 * (hits / max)));
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
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#ff5a3c', emissive: '#ff3010', emissiveIntensity: 0.9 }),
    [],
  );
  const dimMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#3a4656', emissive: '#1a2230', emissiveIntensity: 0.2, transparent: true, opacity: 0.55 }),
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
        return (
          <mesh key={i} position={[pos.x, pos.y, pos.z]} material={isCurrent ? material : dimMaterial}>
            <sphereGeometry args={[TARGET_RADIUS, 16, 16]} />
          </mesh>
        );
      })}
    </group>
  );
}
