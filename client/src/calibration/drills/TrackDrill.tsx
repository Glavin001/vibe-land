// Tracking drill: a single target oscillates on a horizontal sinusoid at
// ~30° amplitude, 4s period. The drill measures the mean angular error
// between the camera's forward vector and the target's world position over
// a 10-second window. Primary signal for gamepad curve exponent and aim-stick
// deadzone (small-motion control feel).
//
// The "edge" variant moves much slower so the player has to make small,
// deliberate stick nudges — the motion that deadzone and curve exponent
// really affect.

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { DrillKind, DrillProps, DrillResult } from './drillTypes';

const TARGET_DISTANCE = 12;
const TARGET_RADIUS = 0.4;

type TrackDrillProps = DrillProps & { kind: 'track' | 'trackEdge' };

type DrillMotion = { amplitudeRad: number; periodSec: number; pitchAmplitudeRad: number; durationMs: number };

function motionFor(kind: DrillKind): DrillMotion {
  if (kind === 'trackEdge') {
    return {
      // Slower and smaller — the "barely moving the stick" regime.
      amplitudeRad: THREE.MathUtils.degToRad(10),
      periodSec: 6,
      pitchAmplitudeRad: THREE.MathUtils.degToRad(4),
      durationMs: 10_000,
    };
  }
  return {
    amplitudeRad: THREE.MathUtils.degToRad(30),
    periodSec: 4,
    pitchAmplitudeRad: THREE.MathUtils.degToRad(6),
    durationMs: 10_000,
  };
}

export function TrackDrill({ runKey, running, onComplete, kind }: TrackDrillProps) {
  const { camera } = useThree();
  const motion = useMemo(() => motionFor(kind), [kind]);

  const anchorRef = useRef<{ position: THREE.Vector3; yaw: number } | null>(null);
  const stateRef = useRef({
    startMs: 0,
    errorSum: 0,
    errorSamples: 0,
    framesOnTarget: 0,
    completed: false,
  });
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    anchorRef.current = null;
    stateRef.current = { startMs: 0, errorSum: 0, errorSamples: 0, framesOnTarget: 0, completed: false };
  }, [runKey]);

  const targetPos = useRef(new THREE.Vector3());
  const forward = useRef(new THREE.Vector3());
  const toTarget = useRef(new THREE.Vector3());

  useFrame(() => {
    if (!running || stateRef.current.completed) return;

    if (!anchorRef.current) {
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      const baseYaw = Math.atan2(-fwd.x, -fwd.z);
      anchorRef.current = { position: camera.position.clone(), yaw: baseYaw };
      stateRef.current.startMs = performance.now();
    }

    const now = performance.now();
    const elapsed = now - stateRef.current.startMs;
    const t = (elapsed / 1000) * (Math.PI * 2) / motion.periodSec;
    const yawOffset = Math.sin(t) * motion.amplitudeRad;
    const pitchOffset = Math.sin(t * 0.5) * motion.pitchAmplitudeRad;
    const yaw = anchorRef.current.yaw + yawOffset;
    const dir = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitchOffset),
      Math.sin(pitchOffset),
      -Math.cos(yaw) * Math.cos(pitchOffset),
    );
    targetPos.current
      .copy(anchorRef.current.position)
      .addScaledVector(dir, TARGET_DISTANCE);

    if (groupRef.current) {
      groupRef.current.position.copy(targetPos.current);
    }

    camera.getWorldDirection(forward.current);
    toTarget.current.subVectors(targetPos.current, camera.position).normalize();
    const dot = Math.min(1, Math.max(-1, forward.current.dot(toTarget.current)));
    const error = Math.acos(dot);
    stateRef.current.errorSum += error;
    stateRef.current.errorSamples += 1;
    if (error <= 0.035) stateRef.current.framesOnTarget += 1;

    if (elapsed >= motion.durationMs) {
      stateRef.current.completed = true;
      const meanError = stateRef.current.errorSum / Math.max(1, stateRef.current.errorSamples);
      const onTargetRatio = stateRef.current.framesOnTarget / Math.max(1, stateRef.current.errorSamples);
      // Blend two signals: mean error (dominant) and fraction of time on target.
      const errScore = 1 - Math.min(1, meanError / 0.08);
      const score = Math.max(0, Math.min(1, errScore * 0.75 + onTargetRatio * 0.25));
      const result: DrillResult = {
        kind,
        hits: stateRef.current.framesOnTarget,
        attempts: stateRef.current.errorSamples,
        totalTimeMs: elapsed,
        meanErrorRad: meanError,
        score,
      };
      onComplete(result);
    }
  });

  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#6cf0a0', emissive: '#19aa4b', emissiveIntensity: 1.4 }),
    [],
  );
  const haloMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: '#b8ffd0',
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      depthTest: false,
    }),
    [],
  );

  if (!running) return null;

  return (
    <group ref={groupRef}>
      <mesh material={haloMaterial} renderOrder={999}>
        <sphereGeometry args={[TARGET_RADIUS * 2, 20, 16]} />
      </mesh>
      <mesh material={material}>
        <sphereGeometry args={[TARGET_RADIUS, 24, 20]} />
      </mesh>
    </group>
  );
}
