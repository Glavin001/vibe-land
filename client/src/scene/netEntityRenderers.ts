// The networked world's entities as the game draws them: players (animated
// characters with HP bars, spawn shields and id labels), dynamic bodies
// (balls, boxes, cannonballs), batteries and vehicles.
//
// Each renderer turns a snapshot of state -- the maps a NetcodeClient keeps,
// sampled through its interpolators at a render time -- into meshes under a
// group, frame by frame. GameWorld drives them from the live runtime inside its
// frame loop; /cityreplay drives the same renderers from a tape's netcode
// client, so a replayed cannonball, car or player is the game's own mesh at
// the game's own interpolated pose.

import * as THREE from 'three';

import type { RemotePlayer } from '../net/netcodeClient';
import type { PlayerSample, VehicleSample } from '../net/interpolation';
import {
  FLAG_DEAD,
  FLAG_IN_VEHICLE,
  FLAG_MELEEING,
  FLAG_ON_GROUND,
  FLAG_SPAWN_PROTECTED,
  SPAWN_PROTECTION_MS,
  type BatteryStateMeters,
  type DynamicBodyStateMeters,
  type NetVehicleState,
  type VehicleStateMeters,
} from '../net/protocol';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { isMeteorBody } from '../vfx/meteorFlights';
import { createRemotePlayer, type RemotePlayerHandle, type RemoteRenderState } from './characterAnim/CharacterFactory';
import { STATE } from './characterAnim/types';
import {
  getVehicleDefinition,
  getVehicleWheelRadiusM,
  getVehicleWheelVisualAnchors,
} from './vehicleVisualGeometry';

export const REMOTE_HIT_FLASH_MS = 180;
export const PLAYER_EYE_HEIGHT = 0.8;
// Keep these in lockstep with `MoveConfig::default()` / hitscan constants in
// the shared Rust physics code so the debug helper matches the authoritative
// collision capsule and head zone.
const PLAYER_CAPSULE_RADIUS = 0.35;
const PLAYER_CAPSULE_HALF_SEGMENT = 0.45;
const PLAYER_CAPSULE_BODY_LENGTH = PLAYER_CAPSULE_HALF_SEGMENT * 2;
const PLAYER_HEAD_RADIUS = 0.22;
const PLAYER_HEAD_CENTER_OFFSET_Y = 0.75;
const REMOTE_SPAWN_SHIELD_RADIUS = PLAYER_CAPSULE_RADIUS + 0.08;
const REMOTE_SPAWN_SHIELD_BODY_LENGTH = PLAYER_CAPSULE_BODY_LENGTH + 0.12;
const VEHICLE_WHEEL_VISUAL_STEER_RATE = 18.0;
export const PLAYER_DEBUG_HELPER_NAME = 'playerPhysicsDebugHelper';

export const PLAYER_COLORS = [0x00ff88, 0xff4444, 0x4488ff, 0xffaa00, 0xff44ff, 0x44ffff, 0xaaff44, 0xff8844];

type VehicleWheelVisualState = {
  spinAngle: number;
  steerAngle: number;
};

type VehicleRenderState = {
  lastBodyPosition: [number, number, number] | null;
  wheels: VehicleWheelVisualState[];
};

export function createPlayerDebugHelper(color: number): THREE.Group {
  const group = new THREE.Group();
  group.name = PLAYER_DEBUG_HELPER_NAME;

  const capsule = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_CAPSULE_RADIUS, PLAYER_CAPSULE_BODY_LENGTH, 6, 12),
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      depthTest: false,
    }),
  );
  group.add(capsule);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(PLAYER_HEAD_RADIUS, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0xff7a7a,
      wireframe: true,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      depthTest: false,
    }),
  );
  head.position.y = PLAYER_HEAD_CENTER_OFFSET_Y;
  group.add(head);

  const eyeGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, PLAYER_EYE_HEIGHT, 0),
  ]);
  const eyeLine = new THREE.Line(
    eyeGeometry,
    new THREE.LineBasicMaterial({
      color: 0xfff27a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      depthTest: false,
    }),
  );
  group.add(eyeLine);

  return group;
}
/** One frame of players to draw. */
export interface RemotePlayersFrame {
  group: THREE.Group;
  players: Map<number, RemotePlayer>;
  sample: (id: number, renderTimeUs: number) => PlayerSample | null;
  renderTimeUs: number;
  vehicles: Map<number, VehicleStateMeters>;
  sampleVehicle: (id: number, renderTimeUs: number) => VehicleSample | null;
  /** The clock hit flashes and spawn shields fade on, ms. */
  nowMs: number;
  /** Animation step, s. */
  frameDelta: number;
  showDebugHelpers: boolean;
  showPlayerIdLabels: boolean;
  cosmeticDeathPhysicsEnabled: boolean;
  /** Ragdoll physics for dead players; none, and a dead player just plays dead. */
  runtime?: GameRuntimeClient;
  /** Players present but not drawn (a spectated player under a first-person camera). */
  hidden?: ReadonlySet<number>;
}

/** Remote players: one animated character each, created on sight, disposed when gone. */
export class RemotePlayersRenderer {
  private readonly meshes = new Map<number, RemotePlayerHandle>();
  private readonly lastHp = new Map<number, number>();
  private readonly hitFlashUntil = new Map<number, number>();
  private readonly lastMeleeing = new Map<number, boolean>();
  private readonly hpBars = new Map<number, RemoteHpBarHandle>();
  private readonly spawnShields = new Map<number, RemoteSpawnShieldHandle>();
  private readonly spawnShieldUntil = new Map<number, number>();

  update(frame: RemotePlayersFrame): void {
    const { group, renderTimeUs, frameDelta } = frame;
    const now = frame.nowMs;
    const activeIds = new Set<number>();
    for (const [id, rp] of frame.players) {
      activeIds.add(id);
      let handle = this.meshes.get(id);
      if (!handle) {
        handle = createRemotePlayer(group, { tint: PLAYER_COLORS[id % PLAYER_COLORS.length], playerId: id, runtime: frame.runtime });
        handle.root.add(createPlayerDebugHelper(PLAYER_COLORS[id % PLAYER_COLORS.length]));
        attachPlayerIdLabel(handle.root, id);
        this.hpBars.set(id, attachRemoteHpBar(handle.root));
        this.spawnShields.set(id, attachRemoteSpawnShield(handle.root));
        this.meshes.set(id, handle);
        console.log('[game] Created mesh for remote player', id);
      }
      const hidden = frame.hidden?.has(id) ?? false;
      const idLabel = handle.root.getObjectByName('idLabel');
      if (idLabel) idLabel.visible = frame.showPlayerIdLabels && !hidden;
      const sample = frame.sample(id, renderTimeUs);
      const remoteFlags = sample?.flags ?? (rp.hp <= 0 ? FLAG_DEAD : 0);
      let position = sample?.position ?? rp.position;
      let yaw = sample?.yaw ?? rp.yaw;
      const replicatedHp = rp.hp;
      const previousHp = this.lastHp.get(id);
      if (previousHp != null && replicatedHp < previousHp) {
        this.hitFlashUntil.set(id, now + REMOTE_HIT_FLASH_MS);
      }
      this.lastHp.set(id, replicatedHp);
      const isDead = (remoteFlags & FLAG_DEAD) !== 0;
      const isInVehicle = (remoteFlags & FLAG_IN_VEHICLE) !== 0;
      const isOnGround = (remoteFlags & FLAG_ON_GROUND) !== 0;
      const isMeleeing = (remoteFlags & FLAG_MELEEING) !== 0;
      const hasSpawnProtection = (remoteFlags & FLAG_SPAWN_PROTECTED) !== 0;
      const wasMeleeing = this.lastMeleeing.get(id) ?? false;
      if (isMeleeing && !wasMeleeing && !isDead) {
        handle.playOneShot('Melee_Hook');
      }
      this.lastMeleeing.set(id, isMeleeing);
      if (isInVehicle) {
        for (const [vehicleId, vehicleState] of frame.vehicles) {
          if (vehicleState.driverId !== id) continue;
          const vehicleSample = frame.sampleVehicle(vehicleId, renderTimeUs);
          const vehiclePosition = vehicleSample?.position ?? vehicleState.position;
          const vehicleQuaternion = vehicleSample?.quaternion ?? vehicleState.quaternion;
          position = [vehiclePosition[0], vehiclePosition[1] + 0.8, vehiclePosition[2]];
          yaw = new THREE.Euler().setFromQuaternion(
            new THREE.Quaternion(
              vehicleQuaternion[0],
              vehicleQuaternion[1],
              vehicleQuaternion[2],
              vehicleQuaternion[3],
            ),
            'YXZ',
          ).y;
          break;
        }
      }
      handle.root.position.set(position[0], position[1], position[2]);
      handle.root.rotation.y = yaw;
      handle.setVisible(!isInVehicle && !hidden);
      const debugHelper = handle.root.getObjectByName(PLAYER_DEBUG_HELPER_NAME);
      if (debugHelper) debugHelper.visible = frame.showDebugHelpers && !isInVehicle && !hidden;

      const hpBar = this.hpBars.get(id);
      if (hpBar) {
        hpBar.setHp(replicatedHp);
        hpBar.setVisible(!isDead && !isInVehicle && !hidden);
      }

      const spawnShield = this.spawnShields.get(id);
      if (spawnShield) {
        if (hasSpawnProtection) {
          if (!this.spawnShieldUntil.has(id)) {
            this.spawnShieldUntil.set(id, now + SPAWN_PROTECTION_MS);
          }
        } else {
          this.spawnShieldUntil.delete(id);
        }
        const shieldUntil = this.spawnShieldUntil.get(id) ?? 0;
        const fadeProgress = Math.max(0, Math.min(1, (shieldUntil - now) / SPAWN_PROTECTION_MS));
        spawnShield.setFadeProgress(fadeProgress);
        spawnShield.setVisible(hasSpawnProtection && !isDead && !isInVehicle && !hidden && fadeProgress > 0);
      }

      const flashUntil = this.hitFlashUntil.get(id) ?? 0;
      const flashAlpha = flashUntil > now ? (flashUntil - now) / REMOTE_HIT_FLASH_MS : 0;
      handle.setFlash(0xfff36b, flashAlpha);
      // Ragdoll is the dead visual cue — keep opacity at 1 while physics-driven.
      handle.setOpacity(1);

      const shouldUseRagdoll = frame.cosmeticDeathPhysicsEnabled && isDead;
      if (shouldUseRagdoll) {
        const sv = new THREE.Vector3(
          sample?.velocity[0] ?? 0,
          sample?.velocity[1] ?? 0,
          sample?.velocity[2] ?? 0,
        );
        handle.setRagdoll(true, sv);
      } else {
        handle.setRagdoll(false);
      }

      const vx = sample?.velocity[0] ?? 0;
      const vz = sample?.velocity[2] ?? 0;
      const horizontalSpeed = Math.hypot(vx, vz);
      const renderState: RemoteRenderState = isDead
        ? 'dead'
        : horizontalSpeed > 0.1
          ? STATE.move
          : STATE.idle;
      handle.update(frameDelta, renderState, horizontalSpeed, isOnGround);
    }

    // Remove stale
    for (const [id, handle] of this.meshes) {
      if (!activeIds.has(id)) {
        const bar = this.hpBars.get(id);
        if (bar) {
          bar.dispose();
          this.hpBars.delete(id);
        }
        const shield = this.spawnShields.get(id);
        if (shield) {
          shield.dispose();
          this.spawnShields.delete(id);
        }
        this.spawnShieldUntil.delete(id);
        handle.dispose();
        this.meshes.delete(id);
        this.lastHp.delete(id);
        this.hitFlashUntil.delete(id);
        this.lastMeleeing.delete(id);
        console.log('[game] Removed mesh for remote player', id);
      }
    }
  }

  /** Where each drawn player's root is, for harnesses. */
  positions(): Map<number, [number, number, number]> {
    const out = new Map<number, [number, number, number]>();
    for (const [id, handle] of this.meshes) {
      out.set(id, [handle.root.position.x, handle.root.position.y, handle.root.position.z]);
    }
    return out;
  }

  dispose(): void {
    for (const bar of this.hpBars.values()) bar.dispose();
    for (const shield of this.spawnShields.values()) shield.dispose();
    for (const handle of this.meshes.values()) handle.dispose();
    this.hpBars.clear();
    this.spawnShields.clear();
    this.meshes.clear();
  }
}

const BALL_COLORS = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff, 0x44ffff, 0xff8800, 0x8800ff];

/** Dynamic bodies: a sphere or box per streamed body, at its rendered pose. */
export class DynamicBodiesRenderer {
  readonly meshes = new Map<number, THREE.Mesh>();

  update(
    group: THREE.Group,
    bodies: Map<number, DynamicBodyStateMeters>,
    rendered: (id: number) => DynamicBodyStateMeters | null,
  ): void {
    const activeBodies = new Set<number>();
    for (const [id, body] of bodies) {
      // A meteor is drawn by its own layer as a burning rock; the sphere
      // the physics streams for it stays unrendered.
      if (isMeteorBody(id)) continue;
      activeBodies.add(id);
      const renderBody = rendered(id) ?? body;
      let mesh = this.meshes.get(id);
      if (!mesh) {
        let geom: THREE.BufferGeometry;
        let mat: THREE.MeshStandardMaterial;
        if (renderBody.shapeType === 1) {
          const radius = renderBody.halfExtents[0];
          geom = new THREE.SphereGeometry(radius, 16, 12);
          mat = new THREE.MeshStandardMaterial({
            color: BALL_COLORS[id % BALL_COLORS.length],
            roughness: 0.4,
            metalness: 0.1,
          });
        } else {
          geom = new THREE.BoxGeometry(
            renderBody.halfExtents[0] * 2,
            renderBody.halfExtents[1] * 2,
            renderBody.halfExtents[2] * 2,
          );
          mat = new THREE.MeshStandardMaterial({
            color: 0xcc6622,
            roughness: 0.6,
            metalness: 0.2,
          });
        }
        mesh = new THREE.Mesh(geom, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(renderBody.position[0], renderBody.position[1], renderBody.position[2]);
        mesh.quaternion.set(
          renderBody.quaternion[0],
          renderBody.quaternion[1],
          renderBody.quaternion[2],
          renderBody.quaternion[3],
        );
        group.add(mesh);
        this.meshes.set(id, mesh);
      }
      mesh.position.set(renderBody.position[0], renderBody.position[1], renderBody.position[2]);
      mesh.quaternion.set(
        renderBody.quaternion[0],
        renderBody.quaternion[1],
        renderBody.quaternion[2],
        renderBody.quaternion[3],
      );
    }
    // Remove stale dynamic body meshes
    for (const [id, mesh] of this.meshes) {
      if (!activeBodies.has(id)) {
        group.remove(mesh);
        this.meshes.delete(id);
      }
    }
  }
}

const BATTERY_MAX_ENERGY = 1000.0;

/** Batteries: a glowing cell each, sat on the ground under it. */
export class BatteriesRenderer {
  private readonly meshes = new Map<number, THREE.Group>();

  update(
    group: THREE.Group,
    batteries: Map<number, BatteryStateMeters>,
    nowMs: number,
    /** Straight-down probe for the ground; null puts the cell on its own base. */
    raycastScene: ((origin: [number, number, number], direction: [number, number, number], maxDistance: number) => { toi: number } | null) | null,
  ): void {
    const t = nowMs / 1000;

    const activeBatteryIds = new Set<number>();
    for (const [id, battery] of batteries) {
      activeBatteryIds.add(id);
      const energyFrac = Math.min(battery.energy / BATTERY_MAX_ENERGY, 1.0);
      const visRadius = 0.12 + energyFrac * 0.25;      // 0.12m → 0.37m
      const visHeight = 0.14 + energyFrac * 0.22;      // 0.14m → 0.36m
      const glowMaxOpacity = 0.4 + energyFrac * 0.5;   // 0.4 → 0.9
      const glowMaxIntensity = 1.2 + energyFrac * 3.0; // 1.2 → 4.2

      let grp = this.meshes.get(id);
      if (!grp) {
        grp = new THREE.Group();

        // Raycast straight down to find the actual terrain surface beneath this battery.
        // Stored once in userData so we don't re-cast every frame.
        const castOrigin: [number, number, number] = [
          battery.position[0],
          battery.position[1] + 20,
          battery.position[2],
        ];
        const hit = raycastScene?.(castOrigin, [0, -1, 0], 40) ?? null;
        grp.userData.groundY =
          hit != null
            ? battery.position[1] + 20 - hit.toi
            : battery.position[1] - battery.height * 0.5;

        const body = new THREE.Mesh(
          new THREE.CylinderGeometry(visRadius, visRadius, visHeight, 20),
          new THREE.MeshStandardMaterial({
            color: 0xffd700,
            emissive: 0xffcc00,
            emissiveIntensity: 1.0,
            roughness: 0.25,
            metalness: 0.65,
          }),
        );
        body.castShadow = true;
        body.name = 'body';

        const glowRing = new THREE.Mesh(
          new THREE.CylinderGeometry(visRadius * 2.2, visRadius * 2.2, visHeight * 1.5, 20),
          new THREE.MeshBasicMaterial({
            color: 0xffee00,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        );
        glowRing.name = 'glow';

        grp.add(body);
        grp.add(glowRing);
        group.add(grp);
        this.meshes.set(id, grp);
      }

      // Sit the bottom of the visual cylinder on the terrain surface
      grp.position.set(
        battery.position[0],
        (grp.userData.groundY as number) + visHeight / 2,
        battery.position[2],
      );

      // Normalized 0→1→0 pulse so body and glow breathe fully in sync.
      // Glow goes from completely transparent to peak opacity and back.
      const pulseFrac = (Math.sin(t * 2.8) + 1) / 2;
      const bodyMesh = grp.getObjectByName('body') as THREE.Mesh | undefined;
      const glowMesh = grp.getObjectByName('glow') as THREE.Mesh | undefined;
      if (bodyMesh) {
        (bodyMesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
          0.3 + pulseFrac * glowMaxIntensity;
      }
      if (glowMesh) {
        (glowMesh.material as THREE.MeshBasicMaterial).opacity =
          pulseFrac * glowMaxOpacity;
        // Ring also expands outward as it brightens for a more dramatic effect
        glowMesh.scale.set(0.85 + pulseFrac * 0.3, 1, 0.85 + pulseFrac * 0.3);
      }
    }

    for (const [id, grp] of this.meshes) {
      if (!activeBatteryIds.has(id)) {
        group.remove(grp);
        grp.traverse((child: THREE.Object3D) => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        this.meshes.delete(id);
      }
    }
  }
}

/** Wheel-visual inputs the local driver's prediction knows better than the snapshot. */
export type VehicleVisualDebug = {
  speedMs: number;
  groundedWheels: number;
  steering: number;
  engineForce: number;
  brake: number;
};

export interface VehiclePose {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /** The local driver's vehicle debug; null for every other vehicle. */
  localDebug: VehicleVisualDebug | null;
}

/** Vehicles: the chassis and its wheels, per vehicle, at the pose the caller resolves. */
export class VehiclesRenderer {
  readonly meshes = new Map<number, THREE.Group>();

  update(
    group: THREE.Group,
    vehicles: Map<number, VehicleStateMeters>,
    frameDelta: number,
    pose: (id: number, state: VehicleStateMeters) => VehiclePose,
    onPlaced?: (id: number, state: VehicleStateMeters, mesh: THREE.Group, pose: VehiclePose) => void,
  ): void {
    const activeVehicleIds = new Set<number>();
    for (const [id, vs] of vehicles) {
      activeVehicleIds.add(id);
      const vehicleType = vs.vehicleType ?? 0;
      let vehicleMeshGroup = this.meshes.get(id);
      if (!vehicleMeshGroup || vehicleMeshGroup.userData.vehicleType !== vehicleType) {
        if (vehicleMeshGroup) {
          group.remove(vehicleMeshGroup);
        }
        vehicleMeshGroup = createVehicleMesh(id, vehicleType);
        group.add(vehicleMeshGroup);
        this.meshes.set(id, vehicleMeshGroup);
      }

      const placed = pose(id, vs);
      const vPos = placed.position;
      const vQuat = placed.quaternion;
      vehicleMeshGroup.position.set(vPos[0], vPos[1], vPos[2]);
      vehicleMeshGroup.quaternion.set(vQuat[0], vQuat[1], vQuat[2], vQuat[3]);

      updateVehicleWheelVisuals(vehicleMeshGroup, vs, placed.localDebug, vPos, vQuat, frameDelta);
      onPlaced?.(id, vs, vehicleMeshGroup, placed);
    }

    // Remove stale vehicle meshes
    for (const [id, mesh] of this.meshes) {
      if (!activeVehicleIds.has(id)) {
        group.remove(mesh);
        this.meshes.delete(id);
      }
    }
  }
}

type VehicleSurfaceSegment = { z0: number; y0: number; z1: number; y1: number };

function vehicleSideProfile(vehicleType: number): [number, number][] {
  const definition = getVehicleDefinition(vehicleType);
  const leftX = -definition.chassisHalfExtents.x;
  const sideProfile = definition.chassisHullVertices
    .filter(([x]) => Math.abs(x - leftX) < 0.001)
    .map(([, y, z]) => [z, y] as [number, number]);
  if (sideProfile.length > 0) {
    return sideProfile;
  }
  return definition.chassisHullVertices
    .slice(0, definition.chassisHullVertices.length / 2)
    .map(([, y, z]) => [z, y] as [number, number]);
}

function profileSegment(
  sideProfile: [number, number][],
  start: number,
  end: number,
): VehicleSurfaceSegment {
  const [z0, y0] = sideProfile[start] ?? sideProfile[0] ?? [0, 0];
  const [z1, y1] = sideProfile[end] ?? sideProfile[start] ?? [0, 0];
  return { z0, y0, z1, y1 };
}

function addVehicleGlassPanels(
  group: THREE.Group,
  halfWidth: number,
  segments: VehicleSurfaceSegment[],
): void {
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0a0c10,
    metalness: 0.25,
    roughness: 0.12,
    transparent: true,
    opacity: 0.85,
  });
  const glassInset = 0.012;
  for (const seg of segments) {
    const dz = seg.z1 - seg.z0;
    const dy = seg.y1 - seg.y0;
    const len = Math.hypot(dz, dy);
    if (len < 1e-4) continue;
    const nz = -dy / len;
    const ny = dz / len;
    const panelGeom = new THREE.PlaneGeometry(halfWidth * 2, len);
    const panel = new THREE.Mesh(panelGeom, glassMat);
    const midZ = (seg.z0 + seg.z1) / 2 - nz * glassInset;
    const midY = (seg.y0 + seg.y1) / 2 - ny * glassInset;
    panel.position.set(0, midY, midZ);
    panel.rotation.set(Math.atan2(dy, dz) - Math.PI / 2, 0, 0);
    panel.receiveShadow = true;
    group.add(panel);
  }
}

function addCybertruckTrim(
  group: THREE.Group,
  chassisHalfExtents: { x: number; y: number; z: number },
  wheelVisualAnchors: [number, number, number][],
  sideProfile: [number, number][],
): void {
  addVehicleGlassPanels(group, chassisHalfExtents.x - 0.08, [
    profileSegment(sideProfile, 3, 4),
    profileSegment(sideProfile, 4, 5),
  ]);

  const lightBarMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveIntensity: 1.2,
    roughness: 0.4,
    metalness: 0.0,
  });
  const frontLight = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.02), lightBarMat);
  frontLight.position.set(0, 0.02, chassisHalfExtents.z - 0.005);
  group.add(frontLight);

  const tailLightMat = new THREE.MeshStandardMaterial({
    color: 0xff2020,
    emissive: 0xff1a1a,
    emissiveIntensity: 1.0,
    roughness: 0.4,
    metalness: 0.0,
  });
  const tailLight = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.02), tailLightMat);
  tailLight.position.set(0, 0.09, -chassisHalfExtents.z + 0.005);
  group.add(tailLight);

  const claddingMat = new THREE.MeshStandardMaterial({
    color: 0x15171a,
    roughness: 0.95,
    metalness: 0.05,
  });
  const claddingGeom = new THREE.BoxGeometry(
    chassisHalfExtents.x * 2 + 0.02,
    0.12,
    chassisHalfExtents.z * 2 - 0.1,
  );
  const cladding = new THREE.Mesh(claddingGeom, claddingMat);
  cladding.position.set(0, -chassisHalfExtents.y + 0.06, 0);
  cladding.castShadow = true;
  cladding.receiveShadow = true;
  group.add(cladding);

  const sideInsetMat = new THREE.MeshStandardMaterial({
    color: 0x252a31,
    roughness: 0.82,
    metalness: 0.18,
  });
  for (const side of [-1, 1]) {
    const forwardInset = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.20, 1.05), sideInsetMat);
    forwardInset.position.set(side * (chassisHalfExtents.x - 0.02), -0.01, 0.78);
    group.add(forwardInset);

    const rearInset = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.18, 1.55), sideInsetMat);
    rearInset.position.set(side * (chassisHalfExtents.x - 0.02), -0.03, -0.75);
    group.add(rearInset);
  }

  for (let i = 0; i < 4; i++) {
    const [ax, , az] = wheelVisualAnchors[i];
    const isFront = i < 2;
    const arch = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, isFront ? 0.24 : 0.21, isFront ? 0.82 : 0.76),
      claddingMat,
    );
    arch.position.set(
      ax * 0.985,
      isFront ? -0.04 : -0.06,
      az + (isFront ? 0.03 : -0.01),
    );
    arch.castShadow = true;
    group.add(arch);
  }
}

function addDeloreanTrim(
  group: THREE.Group,
  chassisHalfExtents: { x: number; y: number; z: number },
  sideProfile: [number, number][],
): void {
  addVehicleGlassPanels(group, chassisHalfExtents.x - 0.1, [
    profileSegment(sideProfile, 2, 3),
    profileSegment(sideProfile, 3, 4),
    profileSegment(sideProfile, 4, 5),
  ]);

  const fasciaMat = new THREE.MeshStandardMaterial({
    color: 0x1c2026,
    roughness: 0.7,
    metalness: 0.15,
  });
  const frontFascia = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.08, 0.08), fasciaMat);
  frontFascia.position.set(0, -0.12, chassisHalfExtents.z - 0.04);
  group.add(frontFascia);

  const tailPanelMat = new THREE.MeshStandardMaterial({
    color: 0x842a22,
    emissive: 0x5e1b15,
    emissiveIntensity: 0.9,
    roughness: 0.45,
    metalness: 0.0,
  });
  const tailPanel = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.08, 0.05), tailPanelMat);
  tailPanel.position.set(0, 0.06, -chassisHalfExtents.z + 0.03);
  group.add(tailPanel);

  const sideTrimMat = new THREE.MeshStandardMaterial({
    color: 0x2a2f36,
    roughness: 0.55,
    metalness: 0.4,
  });
  for (const side of [-1, 1]) {
    const sideTrim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.1, 1.4), sideTrimMat);
    sideTrim.position.set(side * (chassisHalfExtents.x - 0.03), -0.02, -0.1);
    group.add(sideTrim);
  }

  const louverMat = new THREE.MeshStandardMaterial({
    color: 0x20242a,
    roughness: 0.8,
    metalness: 0.1,
  });
  for (let index = 0; index < 4; index += 1) {
    const louver = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.02, 0.18), louverMat);
    louver.position.set(0, 0.18 + index * 0.025, -0.85 - index * 0.08);
    louver.rotation.x = -0.28;
    group.add(louver);
  }
}

function createVehicleMesh(_id: number, vehicleType: number): THREE.Group {
  const group = new THREE.Group();
  const vehicleDefinition = getVehicleDefinition(vehicleType);
  const wheelVisualAnchors = getVehicleWheelVisualAnchors(vehicleDefinition.vehicleType);
  const chassisHalfExtents = vehicleDefinition.chassisHalfExtents;
  const sideProfile = vehicleSideProfile(vehicleDefinition.vehicleType);
  group.userData.vehicleType = vehicleDefinition.vehicleType;
  group.userData.vehicleKey = vehicleDefinition.key;
  group.userData.renderState = {
    lastBodyPosition: null,
    wheels: Array.from({ length: 4 }, () => ({ spinAngle: 0, steerAngle: 0 })),
  } satisfies VehicleRenderState;

  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(sideProfile[0]?.[0] ?? -chassisHalfExtents.z, sideProfile[0]?.[1] ?? -chassisHalfExtents.y);
  for (let i = 1; i < sideProfile.length; i++) {
    bodyShape.lineTo(sideProfile[i][0], sideProfile[i][1]);
  }
  bodyShape.closePath();
  const bodyGeom = new THREE.ExtrudeGeometry(bodyShape, {
    depth: chassisHalfExtents.x * 2,
    bevelEnabled: vehicleDefinition.key === 'cybertruck',
    bevelSize: 0.015,
    bevelThickness: 0.015,
    bevelSegments: 1,
    curveSegments: 1,
  });
  bodyGeom.translate(0, 0, -chassisHalfExtents.x);
  bodyGeom.rotateY(-Math.PI / 2);
  const body = new THREE.Mesh(bodyGeom, new THREE.MeshStandardMaterial({
    color: vehicleDefinition.key === 'cybertruck' ? 0xc9ccd1 : 0xb8bcc5,
    roughness: vehicleDefinition.key === 'cybertruck' ? 0.38 : 0.28,
    metalness: 0.85,
    flatShading: vehicleDefinition.key === 'cybertruck',
  }));
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  if (vehicleDefinition.key === 'cybertruck') {
    addCybertruckTrim(group, chassisHalfExtents, wheelVisualAnchors, sideProfile);
  } else {
    addDeloreanTrim(group, chassisHalfExtents, sideProfile);
  }

  const wheelRadiusM = getVehicleWheelRadiusM(vehicleDefinition.vehicleType);
  const tireWidth = 0.33;
  const tireGeom = new THREE.CylinderGeometry(wheelRadiusM, wheelRadiusM, tireWidth, 20);
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });
  const rimGeom = new THREE.CylinderGeometry(
    wheelRadiusM * 0.6,
    wheelRadiusM * 0.6,
    tireWidth + 0.01,
    8,
  );
  const rimMat = new THREE.MeshStandardMaterial({
    color: vehicleDefinition.key === 'cybertruck' ? 0x2a2e33 : 0x737882,
    roughness: 0.5,
    metalness: 0.6,
    flatShading: true,
  });
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(...wheelVisualAnchors[i]);
    pivot.name = `wheel_pivot_${i}`;
    group.add(pivot);

    const spinGroup = new THREE.Group();
    spinGroup.name = `wheel_spin_${i}`;
    pivot.add(spinGroup);

    const tire = new THREE.Mesh(tireGeom, tireMat);
    tire.rotation.z = Math.PI / 2;
    tire.name = `wheel_${i}`;
    tire.castShadow = true;
    spinGroup.add(tire);

    const rim = new THREE.Mesh(rimGeom, rimMat);
    rim.rotation.z = Math.PI / 2;
    rim.castShadow = true;
    spinGroup.add(rim);
  }

  return group;
}

function updateVehicleWheelVisuals(
  vehicleMeshGroup: THREE.Group,
  vehicleState: Pick<NetVehicleState, 'wheelData'> | Pick<VehicleStateMeters, 'wheelData'>,
  localVehicleDebug: {
    speedMs: number;
    groundedWheels: number;
    steering: number;
    engineForce: number;
    brake: number;
  } | null,
  position: [number, number, number],
  quaternion: [number, number, number, number],
  frameDeltaSec: number,
): void {
  const renderState = vehicleMeshGroup.userData.renderState as VehicleRenderState | undefined;
  if (!renderState) return;
  const vehicleType = vehicleMeshGroup.userData.vehicleType as number | undefined;
  const wheelRadiusM = getVehicleWheelRadiusM(vehicleType);

  const bodySpeed = estimateVehicleForwardSpeed(renderState.lastBodyPosition, position, quaternion, frameDeltaSec);
  renderState.lastBodyPosition = [...position];

  const fallbackSignedSpeed = Math.abs(bodySpeed) > 0.05
    ? bodySpeed
    : (localVehicleDebug
      ? Math.sign(localVehicleDebug.engineForce || 1) * localVehicleDebug.speedMs
      : bodySpeed);

  for (let wi = 0; wi < 4 && wi < vehicleState.wheelData.length; wi++) {
    const pivot = vehicleMeshGroup.getObjectByName(`wheel_pivot_${wi}`) as THREE.Group | undefined;
    const spinGroup = vehicleMeshGroup.getObjectByName(`wheel_spin_${wi}`) as THREE.Group | undefined;
    if (!pivot || !spinGroup) continue;

    const wheelState = renderState.wheels[wi];
    const packed = vehicleState.wheelData[wi];
    const steerByte = (packed & 0xff) as number;
    const replicatedSteer = (steerByte > 127 ? steerByte - 256 : steerByte) / 127;
    const targetSteer = wi < 2
      ? ((localVehicleDebug?.steering ?? replicatedSteer) * 0.5)
      : 0;

    wheelState.steerAngle = THREE.MathUtils.damp(
      wheelState.steerAngle,
      targetSteer,
      VEHICLE_WHEEL_VISUAL_STEER_RATE,
      frameDeltaSec,
    );

    // Wheel spin is integrated locally from chassis motion instead of directly
    // snapping to low-rate replicated wheel angles, which causes visible wobble.
    wheelState.spinAngle += (fallbackSignedSpeed / wheelRadiusM) * frameDeltaSec;
    pivot.rotation.y = wheelState.steerAngle;
    spinGroup.rotation.x = wheelState.spinAngle;
  }
}

function estimateVehicleForwardSpeed(
  lastPosition: [number, number, number] | null,
  position: [number, number, number],
  quaternion: [number, number, number, number],
  frameDeltaSec: number,
): number {
  if (!lastPosition || frameDeltaSec <= 0.0001) return 0;
  const forward = new THREE.Vector3(0, 0, 1);
  forward.applyQuaternion(new THREE.Quaternion(
    quaternion[0],
    quaternion[1],
    quaternion[2],
    quaternion[3],
  ));
  const velocity = new THREE.Vector3(
    (position[0] - lastPosition[0]) / frameDeltaSec,
    (position[1] - lastPosition[1]) / frameDeltaSec,
    (position[2] - lastPosition[2]) / frameDeltaSec,
  );
  return velocity.dot(forward);
}


function attachPlayerIdLabel(parent: THREE.Object3D, id: number): void {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 128, 48);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`P${id}`, 64, 34);
  const texture = new THREE.CanvasTexture(canvas);
  const labelMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(labelMat);
  sprite.name = 'idLabel';
  sprite.visible = false;
  sprite.scale.set(1.2, 0.45, 1);
  // Quaternius rig: root origin sits at body center, model spans ~[-0.6 .. +0.7].
  // Place the label just above the head.
  sprite.position.y = 1.0;
  parent.add(sprite);
}

interface RemoteHpBarHandle {
  setHp(hp: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface RemoteSpawnShieldHandle {
  setFadeProgress(progress: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const REMOTE_HP_BAR_MAX = 100;
const REMOTE_HP_BAR_W = 128;
const REMOTE_HP_BAR_H = 18;

function attachRemoteHpBar(parent: THREE.Object3D): RemoteHpBarHandle {
  const canvas = document.createElement('canvas');
  canvas.width = REMOTE_HP_BAR_W;
  canvas.height = REMOTE_HP_BAR_H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.name = 'remoteHpBar';
  sprite.scale.set(1.0, 0.16, 1);
  sprite.position.y = 1.3;
  // Render slightly on top so it isn't culled behind heads at extreme angles.
  sprite.renderOrder = 999;
  parent.add(sprite);

  let lastDrawnHp = -1;
  const draw = (hp: number): void => {
    const clamped = Math.max(0, Math.min(REMOTE_HP_BAR_MAX, hp));
    ctx.clearRect(0, 0, REMOTE_HP_BAR_W, REMOTE_HP_BAR_H);
    // Frame
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(0, 0, REMOTE_HP_BAR_W, REMOTE_HP_BAR_H);
    // Fill
    const ratio = clamped / REMOTE_HP_BAR_MAX;
    const fillW = Math.round((REMOTE_HP_BAR_W - 4) * ratio);
    let color = '#3ddc84';
    if (ratio < 0.25) color = '#ff4d4d';
    else if (ratio < 0.5) color = '#ffd84d';
    ctx.fillStyle = color;
    ctx.fillRect(2, 2, fillW, REMOTE_HP_BAR_H - 4);
    // Border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, REMOTE_HP_BAR_W - 1, REMOTE_HP_BAR_H - 1);
    texture.needsUpdate = true;
  };

  draw(REMOTE_HP_BAR_MAX);
  lastDrawnHp = REMOTE_HP_BAR_MAX;

  return {
    setHp(hp: number): void {
      const rounded = Math.round(hp);
      if (rounded === lastDrawnHp) return;
      lastDrawnHp = rounded;
      draw(rounded);
    },
    setVisible(visible: boolean): void {
      sprite.visible = visible;
    },
    dispose(): void {
      parent.remove(sprite);
      material.dispose();
      texture.dispose();
    },
  };
}

function attachRemoteSpawnShield(parent: THREE.Object3D): RemoteSpawnShieldHandle {
  const geometry = new THREE.CapsuleGeometry(
    REMOTE_SPAWN_SHIELD_RADIUS,
    REMOTE_SPAWN_SHIELD_BODY_LENGTH,
    8,
    16,
  );
  const material = new THREE.MeshBasicMaterial({
    color: 0x52b8ff,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'remoteSpawnShield';
  mesh.visible = false;
  mesh.renderOrder = 998;
  parent.add(mesh);

  return {
    setFadeProgress(progress: number): void {
      if (progress <= 0) {
        material.opacity = 0;
        return;
      }
      const clamped = THREE.MathUtils.clamp(progress, 0, 1);
      material.opacity = 0.05 + 0.27 * clamped * clamped;
    },
    setVisible(visible: boolean): void {
      mesh.visible = visible;
    },
    dispose(): void {
      parent.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}

