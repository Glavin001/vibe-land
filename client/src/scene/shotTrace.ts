import * as THREE from 'three';

export type ShotTraceKind = 'miss' | 'world' | 'body' | 'head';

export type LocalShotTrace = {
  origin: [number, number, number];
  end: [number, number, number];
  kind: ShotTraceKind;
  expiresAtMs: number;
};

export type RemoteShotHit = {
  distance: number;
  kind: 'body' | 'head';
};

export const LOCAL_SHOT_TRACE_TTL_MS = 90;
export const LOCAL_SHOT_TRACE_MAX_DISTANCE = 80;
export const LOCAL_SHOT_TRACE_BEAM_RADIUS = 0.015;
export const LOCAL_SHOT_TRACE_IMPACT_RADIUS = 0.07;
export const CAMERA_PSEUDO_MUZZLE_OFFSET = new THREE.Vector3(0.18, -0.12, -0.35);

export function pickShotTraceIntercept(
  sceneDistance: number | null,
  remoteHits: RemoteShotHit[],
  maxDistance: number,
): { distance: number; kind: ShotTraceKind } {
  const closestRemote = remoteHits.reduce<RemoteShotHit | null>((closest, hit) => {
    if (!closest || hit.distance < closest.distance) return hit;
    return closest;
  }, null);

  if (closestRemote && (sceneDistance == null || closestRemote.distance < sceneDistance)) {
    return {
      distance: closestRemote.distance,
      kind: closestRemote.kind,
    };
  }

  if (sceneDistance != null) {
    return {
      distance: sceneDistance,
      kind: 'world',
    };
  }

  return {
    distance: maxDistance,
    kind: 'miss',
  };
}

export function shotTraceColor(kind: ShotTraceKind): number {
  switch (kind) {
    case 'head':
      return 0xff4b4b;
    case 'body':
      return 0xff9a5c;
    case 'world':
      return 0xffefb0;
    case 'miss':
    default:
      return 0x9df6ff;
  }
}

export function isShotTraceActive(trace: LocalShotTrace | null, nowMs: number): boolean {
  return Boolean(trace && trace.expiresAtMs > nowMs);
}

export function createLocalShotTrace(
  camera: THREE.Camera,
  nowMs: number,
  aimDirection: [number, number, number],
  remoteHits: RemoteShotHit[],
  blockerDistance: number | null,
): LocalShotTrace {
  const aimOrigin: [number, number, number] = [
    camera.position.x,
    camera.position.y,
    camera.position.z,
  ];
  const intercept = pickShotTraceIntercept(blockerDistance, remoteHits, LOCAL_SHOT_TRACE_MAX_DISTANCE);
  const pseudoMuzzleOrigin = camera.position
    .clone()
    .add(CAMERA_PSEUDO_MUZZLE_OFFSET.clone().applyQuaternion(camera.quaternion));
  const end = [
    aimOrigin[0] + aimDirection[0] * intercept.distance,
    aimOrigin[1] + aimDirection[1] * intercept.distance,
    aimOrigin[2] + aimDirection[2] * intercept.distance,
  ] as [number, number, number];

  return {
    origin: [pseudoMuzzleOrigin.x, pseudoMuzzleOrigin.y, pseudoMuzzleOrigin.z],
    end,
    kind: intercept.kind,
    expiresAtMs: nowMs + LOCAL_SHOT_TRACE_TTL_MS,
  };
}

export function updateLocalShotTraceVisuals(
  trace: LocalShotTrace | null,
  nowMs: number,
  beam: THREE.Mesh | null,
  impact: THREE.Mesh | null,
): void {
  if (!beam || !impact) return;
  if (!isShotTraceActive(trace, nowMs) || !trace) {
    beam.visible = false;
    impact.visible = false;
    return;
  }

  const alpha = Math.max(0, (trace.expiresAtMs - nowMs) / LOCAL_SHOT_TRACE_TTL_MS);
  const color = shotTraceColor(trace.kind);
  const origin = new THREE.Vector3(...trace.origin);
  const end = new THREE.Vector3(...trace.end);
  const delta = new THREE.Vector3().subVectors(end, origin);
  const length = Math.max(delta.length(), 0.001);
  const mid = new THREE.Vector3().addVectors(origin, end).multiplyScalar(0.5);
  const direction = delta.normalize();

  beam.visible = true;
  beam.position.copy(mid);
  beam.scale.set(1, length, 1);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  if (beam.material instanceof THREE.MeshBasicMaterial) {
    beam.material.color.setHex(color);
    beam.material.opacity = alpha * 0.9;
  }

  impact.visible = true;
  impact.position.copy(end);
  impact.scale.setScalar(0.85 + alpha * 0.55);
  if (impact.material instanceof THREE.MeshBasicMaterial) {
    impact.material.color.setHex(color);
    impact.material.opacity = alpha;
  }
}
