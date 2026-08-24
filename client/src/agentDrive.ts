/**
 * Agent drive bridge — window.__VIBE_DRIVE__
 *
 * Mutating control surface for Cursor/browser agents to look, move, and shoot
 * without pointer lock. Separate from read-only window.__VIBE_E2E__.
 *
 * Typical flow:
 *   await __VIBE_DRIVE__.lookAt(0, 3, 0)   // face city center
 *   __VIBE_DRIVE__.move({ forward: 1, durationMs: 2000 })
 *   __VIBE_DRIVE__.fire({ holdMs: 100 })
 *   __VIBE_E2E__.snapshot()
 */

import type { ResolvedGameInput } from './input/types';
import { LOOK_PITCH_MAX, LOOK_PITCH_MIN } from './input/resolver';
import { BTN_CROUCH, BTN_JUMP, BTN_SPRINT } from './net/sharedConstants';
import { recordEvent } from './netlab/recorder';

export type AgentDriveMoveCommand = {
  /** +1 forward, -1 back. */
  forward?: number;
  /** +1 right, -1 left. */
  strafe?: number;
  /** Auto-stop after this many ms. Omit to hold until stop(). */
  durationMs?: number;
};

export type AgentDriveFireCommand = {
  /** How long firePrimary stays true. Default 50ms (one pulse). */
  holdMs?: number;
};

export type AgentDriveStatus = {
  version: number;
  active: boolean;
  yaw: number | null;
  pitch: number | null;
  moveX: number;
  moveY: number;
  sprint: boolean;
  firePrimary: boolean;
  jump: boolean;
};

type DriveState = {
  yaw: number | null;
  pitch: number | null;
  moveX: number;
  moveY: number;
  moveUntil: number;
  sprint: boolean;
  jumpUntil: number;
  fireUntil: number;
  crouch: boolean;
};

const EMPTY_STATE: DriveState = {
  yaw: null,
  pitch: null,
  moveX: 0,
  moveY: 0,
  moveUntil: 0,
  sprint: false,
  jumpUntil: 0,
  fireUntil: 0,
  crouch: false,
};

/**
 * Keep drive state on globalThis so Vite HMR / duplicate module instances
 * (window bridge vs GameWorld import) share one source of truth.
 */
function getState(): DriveState {
  const g = globalThis as typeof globalThis & { __VIBE_DRIVE_STATE__?: DriveState };
  if (!g.__VIBE_DRIVE_STATE__) {
    g.__VIBE_DRIVE_STATE__ = { ...EMPTY_STATE };
  }
  return g.__VIBE_DRIVE_STATE__;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampAxis(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return clamp(value, -1, 1);
}

function nowMs(): number {
  return performance.now();
}

function expireTimedAxes(now: number): void {
  const state = getState();
  if (state.moveUntil > 0 && now >= state.moveUntil) {
    state.moveX = 0;
    state.moveY = 0;
    state.moveUntil = 0;
  }
  if (state.jumpUntil > 0 && now >= state.jumpUntil) {
    state.jumpUntil = 0;
  }
  if (state.fireUntil > 0 && now >= state.fireUntil) {
    state.fireUntil = 0;
  }
}

/** True when the drive bridge is currently overriding player input. */
export function isAgentDriveActive(now: number = nowMs()): boolean {
  const state = getState();
  expireTimedAxes(now);
  return (
    state.yaw != null
    || state.pitch != null
    || Math.abs(state.moveX) > 0.001
    || Math.abs(state.moveY) > 0.001
    || state.sprint
    || state.crouch
    || state.jumpUntil > now
    || state.fireUntil > now
  );
}

/**
 * Build a ResolvedGameInput for this frame, or null when idle.
 * When non-null, GameWorld should prefer this over keyboard/gamepad/bot input.
 */
export function sampleAgentDrive(
  now: number,
  currentYaw: number,
  currentPitch: number,
): ResolvedGameInput | null {
  const state = getState();
  expireTimedAxes(now);
  if (!isAgentDriveActive(now)) {
    return null;
  }

  const yaw = state.yaw ?? currentYaw;
  const pitch = state.pitch ?? currentPitch;
  let buttons = 0;
  if (state.jumpUntil > now) buttons |= BTN_JUMP;
  if (state.sprint) buttons |= BTN_SPRINT;
  if (state.crouch) buttons |= BTN_CROUCH;

  return {
    activeFamily: 'keyboardMouse',
    moveX: state.moveX,
    moveY: state.moveY,
    yaw,
    pitch,
    buttons,
    firePrimary: state.fireUntil > now,
    aimSecondary: false,
    interactPressed: false,
    blockRemovePressed: false,
    blockPlacePressed: false,
    materialSlot1Pressed: false,
    materialSlot2Pressed: false,
    meleePressed: false,
  };
}

function readPlayerPosition(): [number, number, number] | null {
  try {
    const snapshot = window.__VIBE_E2E__?.snapshot();
    if (!snapshot) return null;
    return snapshot.position;
  } catch {
    return null;
  }
}

function lookAtWorldPoint(x: number, y: number, z: number): void {
  const state = getState();
  const position = readPlayerPosition();
  if (!position) {
    // Fall back to facing -Z (toward origin from the +Z city spawn ring).
    state.yaw = Math.PI;
    state.pitch = 0;
    return;
  }
  const dx = x - position[0];
  const dy = y - position[1];
  const dz = z - position[2];
  const horizontal = Math.hypot(dx, dz);
  state.yaw = Math.atan2(dx, dz);
  state.pitch = clamp(Math.atan2(dy, Math.max(1e-4, horizontal)), LOOK_PITCH_MIN, LOOK_PITCH_MAX);
}

export type VibeDriveBridge = {
  version: number;
  /** Absolute look angles (radians). Pitch clamped to look limits. */
  look(yaw: number, pitch?: number): void;
  /** Face a world-space point from the current player position. */
  lookAt(x: number, y: number, z: number): void;
  /** Face the city grid center (origin, eye height ~3 m). */
  faceCity(): void;
  /** Hold movement axes. Optional durationMs auto-stops. */
  move(command?: AgentDriveMoveCommand): void;
  /** Clear movement axes (look / sprint unchanged). */
  stop(): void;
  /** Clear all drive overrides. */
  clear(): void;
  setSprint(on: boolean): void;
  setCrouch(on: boolean): void;
  /** One-frame jump pulse (default 80 ms). */
  jump(holdMs?: number): void;
  /** Hold firePrimary for holdMs (default 50). */
  fire(command?: AgentDriveFireCommand): void;
  status(): AgentDriveStatus;
};

const bridge: VibeDriveBridge = {
  version: 1,

  look(yaw: number, pitch?: number) {
    const state = getState();
    if (!Number.isFinite(yaw)) return;
    state.yaw = yaw;
    if (pitch != null && Number.isFinite(pitch)) {
      state.pitch = clamp(pitch, LOOK_PITCH_MIN, LOOK_PITCH_MAX);
    }
  },

  lookAt(x: number, y: number, z: number) {
    if (![x, y, z].every(Number.isFinite)) return;
    lookAtWorldPoint(x, y, z);
  },

  faceCity() {
    lookAtWorldPoint(0, 3, 0);
  },

  move(command: AgentDriveMoveCommand = {}) {
    const state = getState();
    state.moveY = clampAxis(command.forward);
    state.moveX = clampAxis(command.strafe);
    if (command.durationMs != null && Number.isFinite(command.durationMs) && command.durationMs > 0) {
      state.moveUntil = nowMs() + command.durationMs;
    } else {
      state.moveUntil = 0;
    }
  },

  stop() {
    const state = getState();
    state.moveX = 0;
    state.moveY = 0;
    state.moveUntil = 0;
  },

  clear() {
    const state = getState();
    state.yaw = null;
    state.pitch = null;
    state.moveX = 0;
    state.moveY = 0;
    state.moveUntil = 0;
    state.sprint = false;
    state.crouch = false;
    state.jumpUntil = 0;
    state.fireUntil = 0;
  },

  setSprint(on: boolean) {
    getState().sprint = Boolean(on);
  },

  setCrouch(on: boolean) {
    getState().crouch = Boolean(on);
  },

  jump(holdMs = 80) {
    const hold = Number.isFinite(holdMs) ? Math.max(16, holdMs) : 80;
    getState().jumpUntil = nowMs() + hold;
  },

  fire(command: AgentDriveFireCommand = {}) {
    const hold = command.holdMs != null && Number.isFinite(command.holdMs)
      ? Math.max(16, command.holdMs)
      : 50;
    getState().fireUntil = nowMs() + hold;
  },

  status(): AgentDriveStatus {
    const state = getState();
    const now = nowMs();
    expireTimedAxes(now);
    return {
      version: 1,
      active: isAgentDriveActive(now),
      yaw: state.yaw,
      pitch: state.pitch,
      moveX: state.moveX,
      moveY: state.moveY,
      sprint: state.sprint,
      firePrimary: state.fireUntil > now,
      jump: state.jumpUntil > now,
    };
  },
};

/**
 * Tee every command into the netlab recorder so input intent is time-aligned
 * with the telemetry it produced. status() is read-only and stays untapped.
 */
const RECORDED_COMMANDS = [
  'look', 'lookAt', 'faceCity', 'move', 'stop', 'clear', 'setSprint', 'setCrouch', 'jump', 'fire',
] as const;

for (const name of RECORDED_COMMANDS) {
  const original = bridge[name] as (...args: unknown[]) => unknown;
  (bridge as unknown as Record<string, unknown>)[name] = function wrapped(...args: unknown[]): unknown {
    recordEvent('drive_cmd', { cmd: name, args });
    return original.apply(bridge, args);
  };
}

declare global {
  interface Window {
    __VIBE_DRIVE__?: VibeDriveBridge;
  }
}

if (typeof window !== 'undefined') {
  window.__VIBE_DRIVE__ = bridge;
}

/** Test / non-DOM access to the same bridge installed on window. */
export { bridge as agentDriveBridge };
