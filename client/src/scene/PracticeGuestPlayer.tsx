import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
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

interface PracticeGuestPlayerProps {
  humanId: number;
  device: LocalDeviceAssignment;
  inputBindings: InputBindings;
  runtimeRef: React.RefObject<GameRuntimeClient | null>;
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
 * the shared WASM session via `LocalPracticeClient.connectHuman`, then each
 * frame samples its dedicated `GameInputManager` (bound to the assigned
 * device) and forwards the resulting `InputCmd` through its
 * `LocalHumanSlotHandle`.
 *
 * This v1 supports on-foot movement and look. Firing, vehicle enter/exit,
 * and a dedicated camera/viewport are deferred — the guest character
 * appears in the primary player's viewport as a remote player until the
 * split-screen render refactor lands.
 */
export function PracticeGuestPlayer({
  humanId,
  device,
  inputBindings,
  runtimeRef,
}: PracticeGuestPlayerProps) {
  const managerRef = useRef<GameInputManager | null>(null);
  const handleRef = useRef<LocalHumanSlotHandle | null>(null);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const seqRef = useRef(0);

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

  useFrame((_state, delta) => {
    const manager = managerRef.current;
    const handle = handleRef.current;
    if (!manager || !handle) return;
    const sample = manager.sample(delta, false, 'onFoot', inputBindings, 'auto');
    const action = sample.action;
    if (!action) return;
    const look = advanceLookAngles(yawRef.current, pitchRef.current, action);
    yawRef.current = look.yaw;
    pitchRef.current = look.pitch;
    let buttons = buttonsFromMove(action.moveX, action.moveY);
    if (action.jump) buttons |= BTN_JUMP;
    if (action.sprint) buttons |= BTN_SPRINT;
    if (action.crouch) buttons |= BTN_CROUCH;
    seqRef.current = (seqRef.current + 1) & 0xffff;
    const cmd = buildInputFromButtons(seqRef.current, 0, buttons, look.yaw, look.pitch);
    handle.sendInputs([cmd]);
  });

  return null;
}
