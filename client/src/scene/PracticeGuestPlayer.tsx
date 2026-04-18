import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { GameRuntimeClient } from '../runtime/gameRuntime';
import { LocalPracticeClient, type LocalHumanSlotHandle } from '../net/localPracticeClient';
import { GameInputManager } from '../input/manager';
import type { InputBindings } from '../input/bindings';
import type { LocalDeviceAssignment } from '../input/types';
import { advanceLookAngles } from '../input/resolver';
import { buildInputFromButtons } from './inputBuilder';
import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_SPRINT,
  BTN_FORWARD,
  BTN_BACK,
  BTN_LEFT,
  BTN_RIGHT,
} from '../net/sharedConstants';

const PLAYER_EYE_HEIGHT = 0.8;

export type GuestCameraMap = Map<number, THREE.PerspectiveCamera>;

interface PracticeGuestPlayerProps {
  humanId: number;
  device: LocalDeviceAssignment;
  inputBindings: InputBindings;
  runtimeRef: RefObject<GameRuntimeClient | null>;
  guestCamerasRef: RefObject<GuestCameraMap>;
}

function buttonsFromMove(moveX: number, moveY: number): number {
  let buttons = 0;
  if (moveY > 0.01) buttons |= BTN_FORWARD;
  if (moveY < -0.01) buttons |= BTN_BACK;
  if (moveX > 0.01) buttons |= BTN_RIGHT;
  if (moveX < -0.01) buttons |= BTN_LEFT;
  return buttons;
}

/**
 * Drives one local split-screen **guest** slot (slotId >= 1). Connects to
 * the shared WASM session via `LocalPracticeClient.connectHuman`, samples
 * its dedicated `GameInputManager`, and owns a per-slot
 * `THREE.PerspectiveCamera` positioned first-person at the guest's
 * current sim position. The camera is registered in `guestCamerasRef` so
 * `SplitScreenRenderer` can render one pass per slot.
 */
export function PracticeGuestPlayer({
  humanId,
  device,
  inputBindings,
  runtimeRef,
  guestCamerasRef,
}: PracticeGuestPlayerProps) {
  const managerRef = useRef<GameInputManager | null>(null);
  const handleRef = useRef<LocalHumanSlotHandle | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const seqRef = useRef(0);
  const { camera: defaultCamera } = useThree();
  const camera = useMemo(() => {
    const cam = new THREE.PerspectiveCamera(
      (defaultCamera as THREE.PerspectiveCamera).fov ?? 75,
      1,
      (defaultCamera as THREE.PerspectiveCamera).near ?? 0.1,
      (defaultCamera as THREE.PerspectiveCamera).far ?? 500,
    );
    cam.position.set(0, 2, 10);
    return cam;
  }, [defaultCamera]);

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

  useFrame((_state, delta) => {
    const manager = managerRef.current;
    const handle = handleRef.current;
    if (!manager || !handle) return;
    const sample = manager.sample(delta, false, 'onFoot', inputBindings, 'auto');
    const action = sample.action;
    const look = action
      ? advanceLookAngles(yawRef.current, pitchRef.current, action)
      : { yaw: yawRef.current, pitch: pitchRef.current };
    yawRef.current = look.yaw;
    pitchRef.current = look.pitch;
    if (action) {
      let buttons = buttonsFromMove(action.moveX, action.moveY);
      if (action.jump) buttons |= BTN_JUMP;
      if (action.sprint) buttons |= BTN_SPRINT;
      if (action.crouch) buttons |= BTN_CROUCH;
      seqRef.current = (seqRef.current + 1) & 0xffff;
      const cmd = buildInputFromButtons(seqRef.current, 0, buttons, look.yaw, look.pitch);
      handle.sendInputs([cmd]);
    }

    const host = runtimeRef.current?.getPracticeBotHost();
    if (host instanceof LocalPracticeClient) {
      const remote = host.remotePlayers.get(humanId);
      if (remote) {
        const [px, py, pz] = remote.position;
        const yaw = look.yaw;
        const pitch = look.pitch;
        camera.position.set(px, py + PLAYER_EYE_HEIGHT, pz);
        camera.lookAt(
          px + Math.sin(yaw) * Math.cos(pitch),
          py + PLAYER_EYE_HEIGHT + Math.sin(pitch),
          pz + Math.cos(yaw) * Math.cos(pitch),
        );
      }
    }
  });

  return null;
}
