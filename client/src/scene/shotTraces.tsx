// Shot traces: the beam and impact flash of a shot, from the local fire path
// (the player's own shot, predicted) or the server's shot-fired broadcast
// (everyone's). A fixed pool of meshes draws the most recent ones; GameWorld
// and /cityreplay mount the same pool and feed it the same way.

import { type MutableRefObject } from 'react';
import * as THREE from 'three';

import {
  HIT_ZONE_HEAD,
  WEAPON_CANNONBALL,
  shotFiredToWorldEndpoints,
  type ShotFiredPacket,
} from '../net/protocol';
import { registerDustShot } from '../vfx/dustShots';
import {
  pruneExpiredTraces,
  shotTraceColor,
  shotTraceCoreColor,
  type LocalShotTrace,
  type ShotTraceKind,
} from './shotTrace';

export const LOCAL_SHOT_TRACE_TTL_MS = 140;
const LOCAL_SHOT_TRACE_BEAM_RADIUS = 0.034;
const LOCAL_SHOT_TRACE_CORE_BEAM_RADIUS = 0.012;
const LOCAL_SHOT_TRACE_IMPACT_RADIUS = 0.11;
const LOCAL_SHOT_TRACE_CORE_IMPACT_RADIUS = 0.045;
export const SHOT_TRACE_POOL_SIZE = 16;
const SHOT_TRACE_MAX_ACTIVE = 32;
const SHOT_RESOLUTION_PLAYER_VALUE = 1;
const SHOT_RESOLUTION_DYNAMIC_VALUE = 2;
const SHOT_RESOLUTION_BLOCKED_BY_WORLD_VALUE = 3;

export type ShotTraceVisualSlot = {
  beamOuter: THREE.Mesh | null;
  beamCore: THREE.Mesh | null;
  impactOuter: THREE.Mesh | null;
  impactCore: THREE.Mesh | null;
};

export function createShotTracePool(): ShotTraceVisualSlot[] {
  return Array.from({ length: SHOT_TRACE_POOL_SIZE }, () => ({
    beamOuter: null,
    beamCore: null,
    impactOuter: null,
    impactCore: null,
  }));
}

/**
 * A server shot-fired packet as a trace (and a dust shot, so the first break
 * it causes reads as an entry). `offsetUs` maps the server's fire stamp onto
 * `nowMs`'s clock; a shot whose trace would already have faded draws nothing.
 * `dustAtMs` is the clock the dust matches shots on. Returns whether it drew.
 */
export function applyServerShotFired(
  packet: ShotFiredPacket,
  traces: LocalShotTrace[],
  nextId: () => number,
  offsetUs: number,
  nowMs: number,
  dustAtMs: number,
): boolean {
  const firedAtLocalMs = (packet.serverFireTimeUs - offsetUs) / 1000;
  const expiresAtMs = firedAtLocalMs + LOCAL_SHOT_TRACE_TTL_MS;
  if (expiresAtMs <= nowMs) return false;
  const { origin, end } = shotFiredToWorldEndpoints(packet);
  registerDustShot({
    ox: origin[0], oy: origin[1], oz: origin[2],
    dx: end[0] - origin[0], dy: end[1] - origin[1], dz: end[2] - origin[2],
    ex: packet.weapon === WEAPON_CANNONBALL ? null : end[0],
    ey: packet.weapon === WEAPON_CANNONBALL ? null : end[1],
    ez: packet.weapon === WEAPON_CANNONBALL ? null : end[2],
    weapon: packet.weapon,
    atMs: dustAtMs,
  });
  pushActiveShotTrace(traces, {
    id: nextId(),
    shooterId: packet.shooterPlayerId,
    origin,
    end,
    kind: shotKindFromServer(packet.hitKind, packet.hitZone),
    expiresAtMs,
  });
  return true;
}

/** The pool's meshes; `poolRef` receives them for updatePooledShotTraceVisuals. */
export function ShotTracePool({ poolRef }: { poolRef: MutableRefObject<ShotTraceVisualSlot[]> }) {
  return (
    <>
      {Array.from({ length: SHOT_TRACE_POOL_SIZE }, (_, i) => (
        <group key={`shot-trace-${i}`}>
          <mesh
            ref={(mesh) => {
              poolRef.current[i].beamOuter = mesh;
            }}
            visible={false}
          >
            <cylinderGeometry args={[LOCAL_SHOT_TRACE_BEAM_RADIUS, LOCAL_SHOT_TRACE_BEAM_RADIUS, 1, 10]} />
            <meshBasicMaterial
              transparent
              depthWrite={false}
              opacity={0}
              fog={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
          <mesh
            ref={(mesh) => {
              poolRef.current[i].beamCore = mesh;
            }}
            visible={false}
          >
            <cylinderGeometry args={[LOCAL_SHOT_TRACE_CORE_BEAM_RADIUS, LOCAL_SHOT_TRACE_CORE_BEAM_RADIUS, 1, 10]} />
            <meshBasicMaterial
              transparent
              depthWrite={false}
              opacity={0}
              fog={false}
              toneMapped={false}
            />
          </mesh>
          <mesh
            ref={(mesh) => {
              poolRef.current[i].impactOuter = mesh;
            }}
            visible={false}
          >
            <sphereGeometry args={[LOCAL_SHOT_TRACE_IMPACT_RADIUS, 12, 10]} />
            <meshBasicMaterial
              transparent
              depthWrite={false}
              opacity={0}
              fog={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
          <mesh
            ref={(mesh) => {
              poolRef.current[i].impactCore = mesh;
            }}
            visible={false}
          >
            <sphereGeometry args={[LOCAL_SHOT_TRACE_CORE_IMPACT_RADIUS, 10, 8]} />
            <meshBasicMaterial
              transparent
              depthWrite={false}
              opacity={0}
              fog={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </>
  );
}

export function pushActiveShotTrace(traces: LocalShotTrace[], trace: LocalShotTrace): void {
  if (traces.length >= SHOT_TRACE_MAX_ACTIVE) {
    traces.shift();
  }
  traces.push(trace);
}

export function shotKindFromServer(hitKind: number, hitZone: number): ShotTraceKind {
  if (hitKind === SHOT_RESOLUTION_PLAYER_VALUE) {
    return hitZone === HIT_ZONE_HEAD ? 'head' : 'body';
  }
  if (
    hitKind === SHOT_RESOLUTION_DYNAMIC_VALUE ||
    hitKind === SHOT_RESOLUTION_BLOCKED_BY_WORLD_VALUE
  ) {
    return 'world';
  }
  return 'miss';
}

const _shotTraceBeamDelta = new THREE.Vector3();
const _shotTraceBeamMid = new THREE.Vector3();
const _shotTraceBeamDirection = new THREE.Vector3();
const _shotTraceBeamUp = new THREE.Vector3(0, 1, 0);

function updateShotTraceMeshPair(
  trace: LocalShotTrace,
  nowMs: number,
  slot: ShotTraceVisualSlot,
): void {
  const { beamOuter, beamCore, impactOuter, impactCore } = slot;
  if (!beamOuter || !beamCore || !impactOuter || !impactCore) return;
  const alpha = Math.max(0, (trace.expiresAtMs - nowMs) / LOCAL_SHOT_TRACE_TTL_MS);
  const outerColor = shotTraceColor(trace.kind);
  const coreColor = shotTraceCoreColor(trace.kind);
  _shotTraceBeamDelta.set(
    trace.end[0] - trace.origin[0],
    trace.end[1] - trace.origin[1],
    trace.end[2] - trace.origin[2],
  );
  const length = Math.max(_shotTraceBeamDelta.length(), 0.001);
  _shotTraceBeamMid.set(
    (trace.origin[0] + trace.end[0]) * 0.5,
    (trace.origin[1] + trace.end[1]) * 0.5,
    (trace.origin[2] + trace.end[2]) * 0.5,
  );
  _shotTraceBeamDirection.copy(_shotTraceBeamDelta).normalize();

  for (const beam of [beamOuter, beamCore]) {
    beam.visible = true;
    beam.position.copy(_shotTraceBeamMid);
    beam.scale.set(1, length, 1);
    beam.quaternion.setFromUnitVectors(_shotTraceBeamUp, _shotTraceBeamDirection);
  }
  if (beamOuter.material instanceof THREE.MeshBasicMaterial) {
    beamOuter.material.color.setHex(outerColor);
    beamOuter.material.opacity = alpha * 0.62;
  }
  if (beamCore.material instanceof THREE.MeshBasicMaterial) {
    beamCore.material.color.setHex(coreColor);
    beamCore.material.opacity = Math.min(1, alpha * 0.98);
  }

  for (const impact of [impactOuter, impactCore]) {
    impact.visible = true;
    impact.position.set(trace.end[0], trace.end[1], trace.end[2]);
  }
  impactOuter.scale.setScalar(0.95 + alpha * 0.75);
  impactCore.scale.setScalar(0.85 + alpha * 0.45);
  if (impactOuter.material instanceof THREE.MeshBasicMaterial) {
    impactOuter.material.color.setHex(outerColor);
    impactOuter.material.opacity = alpha * 0.78;
  }
  if (impactCore.material instanceof THREE.MeshBasicMaterial) {
    impactCore.material.color.setHex(coreColor);
    impactCore.material.opacity = Math.min(1, alpha * 0.96);
  }
}

export function updatePooledShotTraceVisuals(
  traces: LocalShotTrace[],
  nowMs: number,
  pool: ShotTraceVisualSlot[],
): void {
  pruneExpiredTraces(traces, nowMs);
  const rendered = Math.min(traces.length, pool.length);
  for (let i = 0; i < rendered; i += 1) {
    updateShotTraceMeshPair(traces[i], nowMs, pool[i]);
  }
  for (let i = rendered; i < pool.length; i += 1) {
    const slot = pool[i];
    if (slot.beamOuter) slot.beamOuter.visible = false;
    if (slot.beamCore) slot.beamCore.visible = false;
    if (slot.impactOuter) slot.impactOuter.visible = false;
    if (slot.impactCore) slot.impactCore.visible = false;
  }
}


