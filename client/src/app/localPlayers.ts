import type { LocalDeviceAssignment } from '../input/types';

export const MAX_LOCAL_PLAYERS = 4;

/**
 * First sim player id reserved for local-human split-screen slots (slot 1
 * onwards). The main local player uses `LOCAL_PLAYER_ID = 1` in the WASM
 * session; bots use the `PRACTICE_BOT_ID_BASE = 1_000_000` range. Keeping
 * humans above both leaves room to grow without collisions.
 */
export const LOCAL_HUMAN_ID_BASE = 2_000_000;

export interface LocalPlayerSlot {
  /** Stable 0..MAX_LOCAL_PLAYERS-1 index. Slot 0 is always the primary
   * local player; 1..3 are optional guests added via the UI. */
  slotId: number;
  /** Sim-side player id. Slot 0 uses the session's allocated id after
   * connect (typically `1`). Guests use `LOCAL_HUMAN_ID_BASE + slotId`. */
  simPlayerId: number | null;
  device: LocalDeviceAssignment;
}

export function defaultSlotZero(): LocalPlayerSlot {
  return { slotId: 0, simPlayerId: null, device: { family: 'keyboardMouse' } };
}

/**
 * Pick a default device for a newly-added slot: the lowest pad index not
 * already assigned (0..3), else keyboard. Callers must re-check
 * uniqueness when committing.
 */
export function pickDefaultDeviceForNewSlot(existing: LocalPlayerSlot[]): LocalDeviceAssignment {
  const usedPadIndices = new Set(
    existing
      .map((slot) => slot.device)
      .filter((device): device is { family: 'gamepad'; index: number } => device.family === 'gamepad')
      .map((device) => device.index),
  );
  const usedKeyboard = existing.some((slot) => slot.device.family === 'keyboardMouse');
  for (let index = 0; index < 4; index += 1) {
    if (!usedPadIndices.has(index)) {
      return { family: 'gamepad', index };
    }
  }
  return usedKeyboard ? { family: 'gamepad', index: 0 } : { family: 'keyboardMouse' };
}

export function deviceKey(device: LocalDeviceAssignment): string {
  return device.family === 'keyboardMouse' ? 'kbm' : `gp${device.index}`;
}

export function isDeviceTakenBy(device: LocalDeviceAssignment, slots: LocalPlayerSlot[], excludingSlotId: number): number | null {
  for (const slot of slots) {
    if (slot.slotId === excludingSlotId) continue;
    if (deviceKey(slot.device) === deviceKey(device)) {
      return slot.slotId;
    }
  }
  return null;
}

export function nextAvailableSlotId(existing: LocalPlayerSlot[]): number | null {
  const used = new Set(existing.map((slot) => slot.slotId));
  for (let id = 0; id < MAX_LOCAL_PLAYERS; id += 1) {
    if (!used.has(id)) return id;
  }
  return null;
}

export function simPlayerIdForSlot(slotId: number, primarySimPlayerId: number | null): number | null {
  if (slotId === 0) return primarySimPlayerId;
  return LOCAL_HUMAN_ID_BASE + slotId;
}
