// A camera the harness can park, for capture and perceptual comparison.
//
// Every look-at-it decision in this project -- fog density, AO strength,
// texture grain -- has to be judged from the SAME viewpoint across candidates,
// and until now there was no way to get one. The player camera is the only
// camera, its spawn moves tens of metres between sessions, and downtown is a
// 21 m grid with no gaps worth standing in: walking to a vantage reliably ends
// up inside a building photographing an unlit interior. Several sweeps were
// thrown away to that before this existed.
//
// Deliberately camera-only. It does not move the player, touch input, or tell
// the server anything -- so hitscan, streaming and the area of interest all
// carry on from wherever the player actually stands, and a capture cannot
// accidentally measure a different part of the city than the one being
// simulated. That also means it is safe to leave installed: nothing reads it
// unless a harness sets it.
//
// A pose is a point and a point looked at, optionally with the camera's up
// (a roll) and its field of view. A MOUNT is a camera fixed to a vehicle as it
// is drawn: an eye in the vehicle's own frame (+x the driver's side, +y up,
// +z forward) and a look in that frame or at a world point. It is resolved
// after the vehicles are placed for the frame (applyCaptureMount), from the
// drawn vehicle itself, so a camera in the driver's seat moves with the car
// on screen to the pixel instead of a frame behind it.

import * as THREE from 'three';
import { resolveMultiplayerBackend } from '../app/runtimeConfig';

export type Vec3 = [number, number, number];

export type CapturePose = {
  position: Vec3;
  lookAt: Vec3;
  /** The camera's up (world), for a roll; world +y when absent. */
  up?: Vec3;
  /** Vertical field of view in degrees; the game's own when absent. */
  fov?: number;
};

/** Named eyes on a vehicle (its frame: +x the driver's side, +y up, +z forward). */
export type MountPoint = 'driver' | 'passenger' | 'hood' | 'bumper' | 'roof' | 'rear' | 'side-left' | 'side-right' | 'wheel-left' | 'wheel-right';

export type CaptureMount = {
  vehicleId: number;
  /** A named eye, or one in the vehicle's frame (metres). */
  eye: MountPoint | Vec3;
  /** Added to the eye, in the vehicle's frame. */
  eyeOffset?: Vec3;
  /** Where to look: yaw (degrees, + to the left) and pitch (degrees, + up) in the vehicle's frame... */
  yaw?: number;
  pitch?: number;
  /** ...or a world point. */
  lookAt?: Vec3;
  /**
   * 'vehicle': the horizon tilts with the vehicle (a camera bolted on);
   * 'level': world up, the vehicle's pitch and roll taken out of the look
   * (a stabilised mount); a number between blends them (0 level, 1 vehicle).
   */
  horizon?: 'vehicle' | 'level' | number;
  /**
   * Seconds of smoothing on the vehicle's heading for the camera frame (a
   * chase camera that swings round after the car, not with it); 0 is rigid.
   */
  headingLag?: number;
  fov?: number;
  /** World offsets added last (camera shake). */
  shake?: { position: Vec3; look: Vec3 };
};

let pose: CapturePose | null = null;
let mount: CaptureMount | null = null;

export function setCapturePose(next: CapturePose | null): void {
  pose = next;
}

export function capturePose(): CapturePose | null {
  return pose;
}

export function setCaptureMount(next: CaptureMount | null): void {
  if (!next || !mount || next.vehicleId !== mount.vehicleId) smoothedHeading = null;
  mount = next;
}

export function captureMount(): CaptureMount | null {
  return mount;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function applyLens(camera: THREE.Camera, fov: number | undefined): void {
  if (fov == null || !('fov' in camera)) return;
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.fov !== fov) {
    perspective.fov = fov;
    perspective.updateProjectionMatrix();
  }
}

/** Apply the parked pose, if one is set. Returns whether it took over. */
export function applyCapturePose(camera: THREE.Camera): boolean {
  if (!pose) return false;
  camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
  if (pose.up) camera.up.set(pose.up[0], pose.up[1], pose.up[2]).normalize();
  else camera.up.copy(WORLD_UP);
  camera.lookAt(pose.lookAt[0], pose.lookAt[1], pose.lookAt[2]);
  camera.up.copy(WORLD_UP);
  applyLens(camera, pose.fov);
  return true;
}

// ------------------------------------------------------------ vehicle eyes

/**
 * What the asset's own parts say (metadata.json, the vehicle's frame): the
 * seats (head restraints, the steering wheel's side) and the extent of its
 * parts, per geometry hash. Until it arrives (or for a vehicle without one),
 * the dune family's seats and a car-sized box.
 */
type AssetEyes = { driver: Vec3; passenger: Vec3; min: Vec3; max: Vec3 };
const DEFAULT_EYES: AssetEyes = { driver: [0.32, 0.73, -0.28], passenger: [-0.32, 0.73, -0.28], min: [-1, -0.4, -2.1], max: [1, 1.5, 2.1] };
const eyesByHash = new Map<string, AssetEyes | 'loading'>();

type Part = { name?: string; id?: string; position?: number[] };

export function eyesFromParts(parts: Part[]): AssetEyes {
  const placed = parts.filter((p) => Array.isArray(p.position) && p.position.length === 3);
  const named = (needle: string) => placed.filter((p) => `${p.name ?? ''} ${p.id ?? ''}`.toLowerCase().includes(needle));
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of placed) for (let k = 0; k < 3; k += 1) { min[k] = Math.min(min[k], p.position![k]); max[k] = Math.max(max[k], p.position![k]); }
  // Part centres, not surfaces: pad by a typical part's half size.
  const box = placed.length ? { min: min.map((v) => v - 0.15) as Vec3, max: max.map((v) => v + 0.15) as Vec3 } : { min: DEFAULT_EYES.min, max: DEFAULT_EYES.max };
  const wheel = named('steering wheel')[0]?.position;
  const restraints = named('head restraint').map((p) => p.position!);
  if (!restraints.length) return { ...DEFAULT_EYES, ...box };
  const side = wheel ? Math.sign(wheel[0]) || 1 : 1;
  const driver = restraints.find((r) => Math.sign(r[0]) === side) ?? restraints[0];
  const passenger = restraints.find((r) => r !== driver) ?? [-driver[0], driver[1], driver[2]];
  // The eyes: a head's depth in front of the restraint, a little above its centre.
  const eye = (r: number[]): Vec3 => [r[0], r[1] + 0.08, r[2] + 0.22];
  return { driver: eye(driver), passenger: eye(passenger), ...box };
}

function eyesFor(object: THREE.Object3D): AssetEyes {
  const hash = object.userData.geometryHash as string | undefined;
  if (!hash) return DEFAULT_EYES;
  const known = eyesByHash.get(hash);
  if (known && known !== 'loading') return known;
  if (!known) {
    eyesByHash.set(hash, 'loading');
    fetch(`${resolveMultiplayerBackend().httpOrigin}/vehicle-assets/${hash}/metadata.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { eyesByHash.set(hash, Array.isArray(m?.parts) ? eyesFromParts(m.parts) : DEFAULT_EYES); })
      .catch(() => eyesByHash.set(hash, DEFAULT_EYES));
  }
  return DEFAULT_EYES;
}

/** A named eye in the vehicle's frame, from its parts. */
export function eyePoint(eyes: AssetEyes, eye: MountPoint | Vec3): Vec3 {
  if (Array.isArray(eye)) return eye;
  const { min, max } = eyes;
  const cz = (min[2] + max[2]) / 2, len = max[2] - min[2];
  switch (eye) {
    case 'driver': return eyes.driver;
    case 'passenger': return eyes.passenger;
    case 'hood': return [0, max[1] - 0.15, max[2] - len * 0.18];
    case 'bumper': return [0, Math.max(min[1] + 0.35, 0), max[2] + 0.15];
    case 'roof': return [0, max[1] + 0.4, cz - len * 0.1];
    case 'rear': return [0, max[1] - 0.1, min[2] - 0.2];
    case 'side-left': return [max[0] + 0.3, (min[1] + max[1]) / 2, cz];
    case 'side-right': return [min[0] - 0.3, (min[1] + max[1]) / 2, cz];
    case 'wheel-left': return [max[0] + 0.35, min[1] + 0.3, cz + len * 0.2];
    case 'wheel-right': return [min[0] - 0.35, min[1] + 0.3, cz + len * 0.2];
    default: return [0, max[1], cz];
  }
}

let smoothedHeading: { yaw: number; atMs: number } | null = null;
const q = new THREE.Quaternion();
const qLevel = new THREE.Quaternion();
const qFrame = new THREE.Quaternion();
const v = new THREE.Vector3();
const look = new THREE.Vector3();
const up = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Apply the mount, if one is set and its vehicle is drawn: call after the
 * vehicles are placed for the frame. Returns whether it took over.
 */
export function applyCaptureMount(camera: THREE.Camera, objectOf: (vehicleId: number) => THREE.Object3D | undefined): boolean {
  if (!mount) return false;
  const object = objectOf(mount.vehicleId);
  if (!object) return false;
  q.copy(object.quaternion);
  euler.setFromQuaternion(q, 'YXZ');
  // The heading the camera frame uses: the car's, or smoothed after it.
  const now = performance.now();
  let yaw = euler.y;
  if (mount.headingLag && mount.headingLag > 0) {
    if (!smoothedHeading) smoothedHeading = { yaw, atMs: now };
    const dt = Math.max(0, (now - smoothedHeading.atMs) / 1000);
    const k = 1 - Math.exp(-dt / mount.headingLag);
    const d = Math.atan2(Math.sin(yaw - smoothedHeading.yaw), Math.cos(yaw - smoothedHeading.yaw));
    smoothedHeading = { yaw: smoothedHeading.yaw + d * k, atMs: now };
    yaw = smoothedHeading.yaw;
  } else smoothedHeading = { yaw, atMs: now };
  qLevel.setFromAxisAngle(WORLD_UP, yaw);
  const horizon = mount.horizon === 'level' ? 0 : mount.horizon === 'vehicle' || mount.horizon == null ? 1 : Math.max(0, Math.min(1, mount.horizon));
  // The eye rides the drawn body (its full rotation, so a seat stays in its seat).
  const e = eyePoint(eyesFor(object), mount.eye);
  const o = mount.eyeOffset ?? [0, 0, 0];
  const bodyFrame = mount.headingLag ? qFrame.copy(qLevel).slerp(q, horizon) : q;
  v.set(e[0] + o[0], e[1] + o[1], e[2] + o[2]).applyQuaternion(bodyFrame).add(object.position);
  // The look: a world point, or yaw/pitch in a frame between level and the body's.
  qFrame.copy(qLevel).slerp(q, horizon);
  if (mount.lookAt) look.set(mount.lookAt[0], mount.lookAt[1], mount.lookAt[2]);
  else {
    const yawR = THREE.MathUtils.degToRad(mount.yaw ?? 0), pitchR = THREE.MathUtils.degToRad(mount.pitch ?? 0);
    look.set(Math.sin(yawR) * Math.cos(pitchR), Math.sin(pitchR), Math.cos(yawR) * Math.cos(pitchR)).applyQuaternion(qFrame).add(v);
  }
  up.set(0, 1, 0).applyQuaternion(qFrame);
  if (mount.shake) {
    v.x += mount.shake.position[0]; v.y += mount.shake.position[1]; v.z += mount.shake.position[2];
    look.x += mount.shake.look[0]; look.y += mount.shake.look[1]; look.z += mount.shake.look[2];
  }
  camera.position.copy(v);
  camera.up.copy(up);
  camera.lookAt(look);
  camera.up.copy(WORLD_UP);
  camera.updateMatrixWorld();
  applyLens(camera, mount.fov);
  return true;
}
