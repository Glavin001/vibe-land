/**
 * MobileControls.tsx — Full-screen touch overlay for mobile gameplay.
 *
 * Layout (landscape):
 *   Left side:  Virtual joystick (movement)
 *   Right side: Touch-to-look area (camera rotation) + action buttons
 *
 * Writes directly to the same refs that the keyboard/mouse handlers use
 * (currentInputRef for movement/actions, playerRotationRef for camera).
 *
 * Uses the Pointer Events API for reliable multi-touch with pointer capture.
 */

import React, { useRef, useCallback, type CSSProperties } from 'react';
import type { InputState } from '../generated/types';
import * as THREE from 'three';

// --- Layout & tuning constants ---
const JOYSTICK_BASE_SIZE = 140;
const JOYSTICK_KNOB_SIZE = 60;
const JOYSTICK_RADIUS = (JOYSTICK_BASE_SIZE - JOYSTICK_KNOB_SIZE) / 2; // 40px travel
const MOVE_DEADZONE = 0.25;
const LOOK_SENSITIVITY = 0.004; // radians per pixel of touch drag
const PITCH_MIN = -Math.PI / 2.5;
const PITCH_MAX = Math.PI / 2.5;

interface MobileControlsProps {
  currentInputRef: React.MutableRefObject<InputState>;
  playerRotationRef: React.MutableRefObject<THREE.Euler>;
}

export const MobileControls: React.FC<MobileControlsProps> = ({
  currentInputRef,
  playerRotationRef,
}) => {
  // --- Joystick state (stored in refs to avoid re-renders) ---
  const joystickActive = useRef(false);
  const joystickPointerId = useRef<number | null>(null);
  const joystickOrigin = useRef({ x: 0, y: 0 });
  const joystickKnobRef = useRef<HTMLDivElement>(null);

  // --- Look state ---
  const lookPointerId = useRef<number | null>(null);
  const lookLastPos = useRef({ x: 0, y: 0 });

  // --- Sprint toggle state ---
  const sprintActive = useRef(false);
  const sprintBtnRef = useRef<HTMLButtonElement>(null);

  // ==================== JOYSTICK ====================

  const updateJoystickInput = useCallback(
    (dx: number, dy: number) => {
      const dist = Math.hypot(dx, dy);
      const norm = dist / JOYSTICK_RADIUS;
      if (norm < MOVE_DEADZONE) {
        currentInputRef.current.forward = false;
        currentInputRef.current.backward = false;
        currentInputRef.current.left = false;
        currentInputRef.current.right = false;
        return;
      }
      // Clamp to unit circle
      const clampedDist = Math.min(dist, JOYSTICK_RADIUS);
      const nx = (dx / dist) * clampedDist / JOYSTICK_RADIUS;
      const ny = (dy / dist) * clampedDist / JOYSTICK_RADIUS;

      // Threshold-based mapping (8-way with overlap)
      const threshold = 0.35;
      currentInputRef.current.forward = ny < -threshold;
      currentInputRef.current.backward = ny > threshold;
      currentInputRef.current.left = nx < -threshold;
      currentInputRef.current.right = nx > threshold;
    },
    [currentInputRef],
  );

  const onJoystickDown = useCallback(
    (e: React.PointerEvent) => {
      if (joystickActive.current) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      joystickActive.current = true;
      joystickPointerId.current = e.pointerId;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      joystickOrigin.current = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    },
    [],
  );

  const onJoystickMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== joystickPointerId.current) return;
      e.preventDefault();
      const dx = e.clientX - joystickOrigin.current.x;
      const dy = e.clientY - joystickOrigin.current.y;

      // Move knob visually (clamped)
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, JOYSTICK_RADIUS);
      const angle = Math.atan2(dy, dx);
      if (joystickKnobRef.current) {
        joystickKnobRef.current.style.transform = `translate(${
          Math.cos(angle) * clamped
        }px, ${Math.sin(angle) * clamped}px)`;
      }

      updateJoystickInput(dx, dy);
    },
    [updateJoystickInput],
  );

  const onJoystickUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== joystickPointerId.current) return;
      joystickActive.current = false;
      joystickPointerId.current = null;
      if (joystickKnobRef.current) {
        joystickKnobRef.current.style.transform = 'translate(0px, 0px)';
      }
      currentInputRef.current.forward = false;
      currentInputRef.current.backward = false;
      currentInputRef.current.left = false;
      currentInputRef.current.right = false;
    },
    [currentInputRef],
  );

  // ==================== LOOK AREA ====================

  const onLookDown = useCallback((e: React.PointerEvent) => {
    if (lookPointerId.current !== null) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    lookPointerId.current = e.pointerId;
    lookLastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onLookMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== lookPointerId.current) return;
      const dx = e.clientX - lookLastPos.current.x;
      const dy = e.clientY - lookLastPos.current.y;
      lookLastPos.current = { x: e.clientX, y: e.clientY };

      // Apply rotation (same convention as the mouse handler in Player.tsx)
      playerRotationRef.current.y -= dx * LOOK_SENSITIVITY;
      playerRotationRef.current.x = Math.max(
        PITCH_MIN,
        Math.min(PITCH_MAX, playerRotationRef.current.x - dy * LOOK_SENSITIVITY),
      );
    },
    [playerRotationRef],
  );

  const onLookUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== lookPointerId.current) return;
    lookPointerId.current = null;
  }, []);

  // ==================== ACTION BUTTONS ====================

  const onButtonDown = useCallback(
    (field: keyof InputState, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      (currentInputRef.current as any)[field] = true;
    },
    [currentInputRef],
  );

  const onButtonUp = useCallback(
    (field: keyof InputState, e: React.PointerEvent) => {
      (currentInputRef.current as any)[field] = false;
    },
    [currentInputRef],
  );

  const onSprintToggle = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      sprintActive.current = !sprintActive.current;
      currentInputRef.current.sprint = sprintActive.current;
      if (sprintBtnRef.current) {
        sprintBtnRef.current.style.background = sprintActive.current
          ? 'rgba(255,200,60,0.45)'
          : 'rgba(255,255,255,0.12)';
      }
    },
    [currentInputRef],
  );

  // ==================== RENDER ====================

  return (
    <div style={containerStyle}>
      {/* ---- LEFT: Movement joystick ---- */}
      <div
        style={joystickBaseStyle}
        onPointerDown={onJoystickDown}
        onPointerMove={onJoystickMove}
        onPointerUp={onJoystickUp}
        onPointerCancel={onJoystickUp}
      >
        <div ref={joystickKnobRef} style={joystickKnobStyle} />
      </div>

      {/* Sprint toggle (above joystick) */}
      <button
        ref={sprintBtnRef}
        style={sprintButtonStyle}
        onPointerDown={onSprintToggle}
      >
        Sprint
      </button>

      {/* ---- RIGHT: Look area (invisible, covers right side) ---- */}
      <div
        style={lookAreaStyle}
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* ---- RIGHT: Action buttons ---- */}
      {/* Attack button — large, prominent */}
      <div
        style={attackButtonStyle}
        onPointerDown={(e) => onButtonDown('attack', e)}
        onPointerUp={(e) => onButtonUp('attack', e)}
        onPointerCancel={(e) => onButtonUp('attack', e)}
      >
        <span style={attackIconStyle}>&#9876;</span>
      </div>

      {/* Jump button */}
      <div
        style={jumpButtonStyle}
        onPointerDown={(e) => onButtonDown('jump', e)}
        onPointerUp={(e) => onButtonUp('jump', e)}
        onPointerCancel={(e) => onButtonUp('jump', e)}
      >
        <span style={btnLabelStyle}>Jump</span>
      </div>

      {/* Cast spell button */}
      <div
        style={castButtonStyle}
        onPointerDown={(e) => onButtonDown('castSpell', e)}
        onPointerUp={(e) => onButtonUp('castSpell', e)}
        onPointerCancel={(e) => onButtonUp('castSpell', e)}
      >
        <span style={btnLabelStyle}>Spell</span>
      </div>
    </div>
  );
};

// ==================== STYLES ====================

const containerStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  pointerEvents: 'none',
};

const joystickBaseStyle: CSSProperties = {
  position: 'absolute',
  left: `calc(24px + env(safe-area-inset-left, 0px))`,
  bottom: `calc(36px + env(safe-area-inset-bottom, 0px))`,
  width: JOYSTICK_BASE_SIZE,
  height: JOYSTICK_BASE_SIZE,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.10)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '2px solid rgba(255,255,255,0.18)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  touchAction: 'none',
  pointerEvents: 'auto',
  userSelect: 'none',
  zIndex: 1,
};

const joystickKnobStyle: CSSProperties = {
  width: JOYSTICK_KNOB_SIZE,
  height: JOYSTICK_KNOB_SIZE,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.35)',
  border: '2px solid rgba(255,255,255,0.5)',
  transition: 'none',
  pointerEvents: 'none',
};

const sprintButtonStyle: CSSProperties = {
  position: 'absolute',
  left: `calc(50px + env(safe-area-inset-left, 0px))`,
  bottom: `calc(${JOYSTICK_BASE_SIZE + 56}px + env(safe-area-inset-bottom, 0px))`,
  width: 72,
  height: 40,
  borderRadius: 20,
  background: 'rgba(255,255,255,0.12)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '1.5px solid rgba(255,255,255,0.2)',
  color: '#fff',
  fontSize: 13,
  fontFamily: 'monospace',
  touchAction: 'none',
  pointerEvents: 'auto',
  userSelect: 'none',
  cursor: 'default',
  padding: 0,
  zIndex: 1,
};

const lookAreaStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  width: '55%',
  height: '100%',
  touchAction: 'none',
  pointerEvents: 'auto',
  zIndex: 0,
  // Invisible — just captures touch events
};

const attackButtonStyle: CSSProperties = {
  position: 'absolute',
  right: `calc(28px + env(safe-area-inset-right, 0px))`,
  bottom: `calc(80px + env(safe-area-inset-bottom, 0px))`,
  width: 80,
  height: 80,
  borderRadius: '50%',
  background: 'rgba(255,70,70,0.28)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '2px solid rgba(255,100,100,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  touchAction: 'none',
  pointerEvents: 'auto',
  userSelect: 'none',
  zIndex: 1,
};

const attackIconStyle: CSSProperties = {
  fontSize: 32,
  color: 'rgba(255,255,255,0.85)',
  pointerEvents: 'none',
};

const jumpButtonStyle: CSSProperties = {
  position: 'absolute',
  right: `calc(120px + env(safe-area-inset-right, 0px))`,
  bottom: `calc(32px + env(safe-area-inset-bottom, 0px))`,
  width: 60,
  height: 60,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.12)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '1.5px solid rgba(255,255,255,0.2)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  touchAction: 'none',
  pointerEvents: 'auto',
  userSelect: 'none',
  zIndex: 1,
};

const castButtonStyle: CSSProperties = {
  position: 'absolute',
  right: `calc(120px + env(safe-area-inset-right, 0px))`,
  bottom: `calc(106px + env(safe-area-inset-bottom, 0px))`,
  width: 60,
  height: 60,
  borderRadius: '50%',
  background: 'rgba(100,140,255,0.22)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: '1.5px solid rgba(130,170,255,0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  touchAction: 'none',
  pointerEvents: 'auto',
  userSelect: 'none',
  zIndex: 1,
};

const btnLabelStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: 'monospace',
  color: 'rgba(255,255,255,0.8)',
  pointerEvents: 'none',
  userSelect: 'none',
};
