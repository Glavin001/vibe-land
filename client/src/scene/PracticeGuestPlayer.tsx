import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { LocalPracticeClient, type LocalHumanSlotHandle } from '../net/localPracticeClient';
import { GameInputManager } from '../input/manager';
import type { InputBindings } from '../input/bindings';
import type { LocalDeviceAssignment } from '../input/types';
import {
  advanceLookAngles,
  advanceVehicleCamera,
  VEHICLE_CAMERA_DEFAULT_PITCH,
} from '../input/resolver';
import { FixedInputBundler } from '../runtime/fixedInputBundler';
import { FIXED_DT, CLIENT_MAX_CATCHUP_STEPS } from '../runtime/clientSimConstants';
import { configureCameraLayersForLocalSlot } from './splitScreenLayers';
import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
  FLAG_DEAD,
  WEAPON_HITSCAN,
  RIFLE_FIRE_INTERVAL_MS,
} from '../net/sharedConstants';
import type { VehicleStateMeters } from '../net/protocol';

const PLAYER_EYE_HEIGHT = 0.8;
const VEHICLE_INTERACT_RADIUS = 4.0;
const VEHICLE_CAMERA_DISTANCE = 6.5;
const VEHICLE_CAMERA_HEIGHT = 2.5;
/**
 * Each guest reserves a distinct shot-id prefix so its locally-generated
 * shot ids never collide with slot 0's (which starts at 1 and counts up).
 * 24-bit shards give us ~16M shots per slot before wraparound.
 */
const GUEST_SHOT_ID_SHARD = 0x01000000;

export type GuestCameraMap = Map<number, THREE.PerspectiveCamera>;

export type GuestHudEntry = {
  hp: number;
  energy: number;
  /** Whether this slot is currently driving a vehicle. */
  inVehicle: boolean;
  /** Whether the player slot is still alive (hp > 0 and not flagged dead). */
  alive: boolean;
};

export type GuestHudMap = Map<number, GuestHudEntry>;

interface PracticeGuestPlayerProps {
  slotId: number;
  humanId: number;
  device: LocalDeviceAssignment;
  inputBindings: InputBindings;
  runtimeRef: RefObject<GameRuntimeClient | null>;
  guestCamerasRef: RefObject<GuestCameraMap>;
  guestHudRef: RefObject<GuestHudMap>;
}

function buttonsFromMove(moveX: number, moveY: number): number {
  let buttons = 0;
  if (moveY > 0.01) buttons |= BTN_FORWARD;
  if (moveY < -0.01) buttons |= BTN_BACK;
  if (moveX > 0.01) buttons |= BTN_RIGHT;
  if (moveX < -0.01) buttons |= BTN_LEFT;
  return buttons;
}

function findDrivenVehicle(
  client: LocalPracticeClient,
  humanId: number,
): { id: number; state: VehicleStateMeters } | null {
  for (const [id, state] of client.vehicles) {
    if (state.driverId === humanId) return { id, state };
  }
  return null;
}

function findNearestEnterableVehicle(
  client: LocalPracticeClient,
  position: [number, number, number],
): number | null {
  let best: { id: number; dist: number } | null = null;
  for (const [id, vs] of client.vehicles) {
    if (vs.driverId !== 0) continue;
    const dx = vs.position[0] - position[0];
    const dz = vs.position[2] - position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < VEHICLE_INTERACT_RADIUS && (best == null || dist < best.dist)) {
      best = { id, dist };
    }
  }
  return best ? best.id : null;
}

/**
 * Drives one local split-screen **guest** slot (slotId >= 1). Connects to
 * the shared WASM session via `LocalPracticeClient.connectHuman`, samples
 * its dedicated `GameInputManager`, and owns a per-slot
 * `THREE.PerspectiveCamera` that tracks the guest's position (first-person
 * on foot, chase-cam while driving). Each frame it:
 *
 * 1. Samples input and forwards an `InputCmd` through its slot handle.
 * 2. Issues fire packets when primary-fire is pressed on foot.
 * 3. Handles E/interact for enter/exit of the nearest authored vehicle.
 * 4. Publishes HP/energy/alive/inVehicle state into the shared HUD ref so
 *    the per-viewport HUD overlay can render it without extra wiring.
 */
export function PracticeGuestPlayer({
  slotId,
  humanId,
  device,
  inputBindings,
  runtimeRef,
  guestCamerasRef,
  guestHudRef,
}: PracticeGuestPlayerProps) {
  const managerRef = useRef<GameInputManager | null>(null);
  const handleRef = useRef<LocalHumanSlotHandle | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const vehicleOrbitYawRef = useRef(0);
  const vehicleOrbitPitchRef = useRef(VEHICLE_CAMERA_DEFAULT_PITCH);
  const seqRef = useRef(0);
  const nextShotIdRef = useRef((slotId + 1) * GUEST_SHOT_ID_SHARD + 1);
  const nextFireMsRef = useRef(0);
  const { camera: defaultCamera } = useThree();
  // Guests must bundle inputs at the sim tick rate (60 Hz). Sending one
  // InputCmd per render frame overfills the session's per-player input
  // queue (drained at 60 Hz, capped at MAX_PENDING_INPUTS=120), producing
  // up to ~2 s of movement lag on high-refresh displays. Look is unaffected
  // because it's applied locally.
  const bundler = useMemo(
    () => new FixedInputBundler(FIXED_DT, CLIENT_MAX_CATCHUP_STEPS),
    [],
  );
  const camera = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(
      (defaultCamera as THREE.PerspectiveCamera).fov ?? 75,
      1,
      (defaultCamera as THREE.PerspectiveCamera).near ?? 0.1,
      (defaultCamera as THREE.PerspectiveCamera).far ?? 500,
    );
    cam.position.set(0, 2, 10);
    configureCameraLayersForLocalSlot(cam, slotId);
    return cam;
  }, [defaultCamera, slotId]);

  useEffect(() => {
    const manager = new GameInputManager(device);
    manager.attach();
    managerRef.current = manager;
    return () => {
      manager.detach();
      managerRef.current = null;
    };
  }, [device]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    const host = runtime?.getPracticeBotHost();
    if (!(host instanceof LocalPracticeClient)) return;
    const handle = host.connectHuman(humanId);
    if (!handle) return;
    handleRef.current = handle;
    return () => {
      handle.disconnect();
      handleRef.current = null;
    };
  }, [humanId, runtimeRef]);

  useEffect(() => {
    const map = guestCamerasRef.current;
    if (!map) return;
    map.set(humanId, camera);
    return () => {
      map.delete(humanId);
    };
  }, [humanId, camera, guestCamerasRef]);

  useEffect(() => {
    const hud = guestHudRef.current;
    if (!hud) return;
    hud.set(humanId, { hp: 100, energy: 0, inVehicle: false, alive: true });
    return () => {
      hud.delete(humanId);
    };
  }, [humanId, guestHudRef]);

  useFrame((_state, delta) => {
    const manager = managerRef.current;
    const handle = handleRef.current;
    const runtime = runtimeRef.current;
    const host = runtime?.getPracticeBotHost();
    if (!manager || !handle || !(host instanceof LocalPracticeClient)) return;

    const drivenVehicle = findDrivenVehicle(host, humanId);
    const isDriving = drivenVehicle != null;

    const sample = manager.sample(
      delta,
      false,
      isDriving ? 'vehicle' : 'onFoot',
      inputBindings,
      'auto',
    );
    const action = sample.action;

    if (isDriving) {
      const updated = advanceVehicleCamera(
        vehicleOrbitYawRef.current,
        vehicleOrbitPitchRef.current,
        action,
        16,
        delta,
      );
      vehicleOrbitYawRef.current = updated.orbitYaw;
      vehicleOrbitPitchRef.current = updated.orbitPitch;
    } else {
      const look = action
        ? advanceLookAngles(yawRef.current, pitchRef.current, action)
        : { yaw: yawRef.current, pitch: pitchRef.current };
      yawRef.current = look.yaw;
      pitchRef.current = look.pitch;
    }

    const remote = host.remotePlayers.get(humanId);
    const pos: [number, number, number] = remote?.position ?? [0, 0, 0];
    const alive = remote ? remote.hp > 0 && (remote.flags & FLAG_DEAD) === 0 : true;

    if (action && alive) {
      let buttons: number;
      let moveX: number;
      let moveY: number;
      let sendYaw: number;
      let sendPitch: number;
      if (isDriving) {
        moveX = Math.max(-1, Math.min(1, action.steer ?? action.moveX ?? 0));
        moveY = Math.max(-1, Math.min(1, (action.throttle ?? 0) - (action.brake ?? 0)));
        buttons = 0;
        if (action.handbrake) buttons |= BTN_JUMP;
        sendYaw = vehicleOrbitYawRef.current;
        sendPitch = vehicleOrbitPitchRef.current;
      } else {
        moveX = action.moveX;
        moveY = action.moveY;
        buttons = buttonsFromMove(moveX, moveY);
        if (action.jump) buttons |= BTN_JUMP;
        if (action.sprint) buttons |= BTN_SPRINT;
        if (action.crouch) buttons |= BTN_CROUCH;
        sendYaw = yawRef.current;
        sendPitch = pitchRef.current;
      }
      const cmds = bundler.produce(delta, {
        moveX,
        moveY,
        yaw: sendYaw,
        pitch: sendPitch,
        buttons,
      });
      if (cmds.length > 0) {
        seqRef.current = cmds[cmds.length - 1].seq & 0xffff;
        handle.sendInputs(cmds);
      }

      if (action.interactPressed) {
        if (isDriving && drivenVehicle) {
          handle.exitVehicle(drivenVehicle.id);
        } else if (!isDriving) {
          const nearest = findNearestEnterableVehicle(host, pos);
          if (nearest != null) handle.enterVehicle(nearest);
        }
      }

      if (!isDriving && action.firePrimary) {
        const now = performance.now();
        if (now >= nextFireMsRef.current) {
          nextFireMsRef.current = now + RIFLE_FIRE_INTERVAL_MS;
          const yaw = yawRef.current;
          const pitch = pitchRef.current;
          const dir: [number, number, number] = [
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch),
          ];
          const shotId = nextShotIdRef.current;
          nextShotIdRef.current = shotId + 1;
          handle.sendFire({
            seq: seqRef.current,
            shotId: shotId >>> 0,
            weapon: WEAPON_HITSCAN,
            clientFireTimeUs: host.serverClock.serverNowUs(),
            clientInterpMs: 0,
            clientDynamicInterpMs: 0,
            dir,
          });
        }
      }
    }

    // Camera tracking: first-person on foot; chase-cam when driving.
    if (isDriving && drivenVehicle) {
      const vpos = drivenVehicle.state.position;
      const totalYaw = vehicleOrbitYawRef.current;
      const totalPitch = vehicleOrbitPitchRef.current;
      const camX = vpos[0] - Math.sin(totalYaw) * VEHICLE_CAMERA_DISTANCE * Math.cos(totalPitch);
      const camY = vpos[1] + VEHICLE_CAMERA_HEIGHT + Math.sin(totalPitch) * VEHICLE_CAMERA_DISTANCE;
      const camZ = vpos[2] - Math.cos(totalYaw) * VEHICLE_CAMERA_DISTANCE * Math.cos(totalPitch);
      camera.position.set(camX, camY, camZ);
      camera.lookAt(vpos[0], vpos[1] + 1.0, vpos[2]);
    } else if (remote) {
      const yaw = yawRef.current;
      const pitch = pitchRef.current;
      camera.position.set(pos[0], pos[1] + PLAYER_EYE_HEIGHT, pos[2]);
      camera.lookAt(
        pos[0] + Math.sin(yaw) * Math.cos(pitch),
        pos[1] + PLAYER_EYE_HEIGHT + Math.sin(pitch),
        pos[2] + Math.cos(yaw) * Math.cos(pitch),
      );
    }

    const hud = guestHudRef.current;
    if (hud) {
      hud.set(humanId, {
        hp: remote?.hp ?? 0,
        energy: (remote?.energyCenti ?? 0) / 100,
        inVehicle: isDriving,
        alive,
      });
    }
  });

  return null;
}
