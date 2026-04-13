import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputSample } from '../input/types';

const UI_UPDATE_INTERVAL_MS = 33;
const FLASH_MS = 160;

export type ControlHintsState = {
  activeFamily: InputSample['activeFamily'];
  context: InputSample['context'];
  action: InputSample['action'];
  machineDisplayName: string | null;
  machineBindings: ReadonlyArray<{
    action: string;
    posKey: string;
    negKey: string | null;
    scale: number;
  }>;
  /// Live scalar values per snap-machine action channel, in
  /// `bindings` order. Each slot is `-127..127`. The overlay uses
  /// these to light up hint rows as keys are held.
  machineChannels: Int8Array;
};

function createDefaultState(): ControlHintsState {
  return {
    activeFamily: null,
    context: 'onFoot',
    action: null,
    machineDisplayName: null,
    machineBindings: [],
    machineChannels: new Int8Array(0),
  };
}

export function useControlHints() {
  const [displayState, setDisplayState] = useState<ControlHintsState>(createDefaultState);
  const stateRef = useRef<ControlHintsState>(createDefaultState());
  const lastUiUpdate = useRef(0);
  const flashUntilRef = useRef({
    interactPressed: 0,
    resetVehiclePressed: 0,
    blockRemovePressed: 0,
    blockPlacePressed: 0,
    materialSlot1Pressed: 0,
    materialSlot2Pressed: 0,
  });
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 1024);

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const updateInputFrame = useCallback((sample: InputSample) => {
    const now = performance.now();
    const action = sample.action;
    if (action?.interactPressed) flashUntilRef.current.interactPressed = now + FLASH_MS;
    if (action?.resetVehiclePressed) flashUntilRef.current.resetVehiclePressed = now + FLASH_MS;
    if (action?.blockRemovePressed) flashUntilRef.current.blockRemovePressed = now + FLASH_MS;
    if (action?.blockPlacePressed) flashUntilRef.current.blockPlacePressed = now + FLASH_MS;
    if (action?.materialSlot1Pressed) flashUntilRef.current.materialSlot1Pressed = now + FLASH_MS;
    if (action?.materialSlot2Pressed) flashUntilRef.current.materialSlot2Pressed = now + FLASH_MS;

    stateRef.current = {
      activeFamily: sample.activeFamily,
      context: sample.context,
      action: sample.action,
      machineDisplayName: sample.machineDisplayName ?? null,
      machineBindings: sample.machineBindings ?? [],
      machineChannels: sample.machineChannels ?? new Int8Array(0),
    };

    if (now - lastUiUpdate.current < UI_UPDATE_INTERVAL_MS) {
      return;
    }
    lastUiUpdate.current = now;

    setDisplayState({
      activeFamily: sample.activeFamily,
      context: sample.context,
      action: action
        ? {
            ...action,
            interactPressed: action.interactPressed || flashUntilRef.current.interactPressed > now,
            resetVehiclePressed: action.resetVehiclePressed || flashUntilRef.current.resetVehiclePressed > now,
            blockRemovePressed: action.blockRemovePressed || flashUntilRef.current.blockRemovePressed > now,
            blockPlacePressed: action.blockPlacePressed || flashUntilRef.current.blockPlacePressed > now,
            materialSlot1Pressed: action.materialSlot1Pressed || flashUntilRef.current.materialSlot1Pressed > now,
            materialSlot2Pressed: action.materialSlot2Pressed || flashUntilRef.current.materialSlot2Pressed > now,
          }
        : null,
      machineDisplayName: sample.machineDisplayName ?? null,
      machineBindings: sample.machineBindings ?? [],
      machineChannels: sample.machineChannels ?? new Int8Array(0),
    });
  }, []);

  return { displayState, updateInputFrame, isDesktop };
}
