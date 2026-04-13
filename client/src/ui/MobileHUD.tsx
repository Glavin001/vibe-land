import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { isTouchDevice } from '../device';
import {
  JOYSTICK_DEADZONE,
  JOYSTICK_INNER_RADIUS_PX,
  JOYSTICK_SPRINT_RADIUS_PX,
  touchInputSource,
} from '../input/touch';

type JoystickVisual = {
  originX: number;
  originY: number;
  knobDx: number;
  knobDy: number;
  sprinting: boolean;
  visible: boolean;
};

const HIDDEN_JOYSTICK: JoystickVisual = {
  originX: 0,
  originY: 0,
  knobDx: 0,
  knobDy: 0,
  sprinting: false,
  visible: false,
};

function applyRadialDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return [0, 0];
  const scaled = (mag - deadzone) / (1 - deadzone);
  const k = scaled / mag;
  return [x * k, y * k];
}

export function MobileHUD() {
  if (!isTouchDevice()) return null;
  return <MobileHUDImpl />;
}

function MobileHUDImpl() {
  const [joystick, setJoystick] = useState<JoystickVisual>(HIDDEN_JOYSTICK);
  const movePointerIdRef = useRef<number | null>(null);
  const moveOriginRef = useRef<{ x: number; y: number } | null>(null);

  const lookPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  // Block iOS pinch zoom & long-press context menu while the HUD is mounted.
  useEffect(() => {
    const preventGesture = (e: Event) => e.preventDefault();
    const preventContext = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('gesturestart', preventGesture as EventListener);
    document.addEventListener('gesturechange', preventGesture as EventListener);
    document.addEventListener('gestureend', preventGesture as EventListener);
    document.addEventListener('contextmenu', preventContext);
    return () => {
      document.removeEventListener('gesturestart', preventGesture as EventListener);
      document.removeEventListener('gesturechange', preventGesture as EventListener);
      document.removeEventListener('gestureend', preventGesture as EventListener);
      document.removeEventListener('contextmenu', preventContext);
      touchInputSource.reset();
    };
  }, []);

  // ---- Movement half ----

  const updateMove = useCallback((clientX: number, clientY: number) => {
    const origin = moveOriginRef.current;
    if (!origin) return;
    const rawDx = clientX - origin.x;
    const rawDy = clientY - origin.y;
    const dist = Math.hypot(rawDx, rawDy);

    // Clamp the visual knob to the inner radius.
    const clampScale = dist > JOYSTICK_INNER_RADIUS_PX ? JOYSTICK_INNER_RADIUS_PX / dist : 1;
    const knobDx = rawDx * clampScale;
    const knobDy = rawDy * clampScale;

    // Normalize to -1..1 and invert Y so pushing up = moveY +1 (matches WASD).
    const nx = knobDx / JOYSTICK_INNER_RADIUS_PX;
    const ny = -knobDy / JOYSTICK_INNER_RADIUS_PX;
    const [deadX, deadY] = applyRadialDeadzone(nx, ny, JOYSTICK_DEADZONE);
    const sprinting = dist > JOYSTICK_SPRINT_RADIUS_PX;

    touchInputSource.setMoveVector(deadX, deadY, sprinting);
    setJoystick({
      originX: origin.x,
      originY: origin.y,
      knobDx,
      knobDy,
      sprinting,
      visible: true,
    });
  }, []);

  const handleMovePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointerIdRef.current !== null) return;
    movePointerIdRef.current = e.pointerId;
    moveOriginRef.current = { x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Safari may throw if target detached */
    }
    updateMove(e.clientX, e.clientY);
  }, [updateMove]);

  const handleMovePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointerIdRef.current !== e.pointerId) return;
    updateMove(e.clientX, e.clientY);
  }, [updateMove]);

  const endMovePointer = useCallback((pointerId: number) => {
    if (movePointerIdRef.current !== pointerId) return;
    movePointerIdRef.current = null;
    moveOriginRef.current = null;
    touchInputSource.setMoveVector(0, 0, false);
    setJoystick(HIDDEN_JOYSTICK);
  }, []);

  // ---- Look half ----

  const handleLookPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    lookPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const handleLookPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const last = lookPointersRef.current.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    lookPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    touchInputSource.addLookDelta(dx, dy);
  }, []);

  const endLookPointer = useCallback((pointerId: number) => {
    lookPointersRef.current.delete(pointerId);
  }, []);

  return (
    <div style={rootStyle}>
      {/* Movement capture layer (left half) */}
      <div
        style={leftHalfStyle}
        onPointerDown={handleMovePointerDown}
        onPointerMove={handleMovePointerMove}
        onPointerUp={(e) => endMovePointer(e.pointerId)}
        onPointerCancel={(e) => endMovePointer(e.pointerId)}
        onLostPointerCapture={(e) => endMovePointer(e.pointerId)}
      />

      {/* Look capture layer (right half) — sits beneath the buttons */}
      <div
        style={rightHalfStyle}
        onPointerDown={handleLookPointerDown}
        onPointerMove={handleLookPointerMove}
        onPointerUp={(e) => endLookPointer(e.pointerId)}
        onPointerCancel={(e) => endLookPointer(e.pointerId)}
        onLostPointerCapture={(e) => endLookPointer(e.pointerId)}
      />

      {/* Joystick placeholder hint (always visible to suggest where to touch) */}
      <div style={joystickPlaceholderStyle} />

      {/* Active joystick visualization */}
      {joystick.visible && (
        <>
          <div
            style={{
              ...joystickRingStyle,
              left: joystick.originX,
              top: joystick.originY,
              borderColor: joystick.sprinting
                ? 'rgba(255, 196, 96, 0.9)'
                : 'rgba(255, 255, 255, 0.35)',
              boxShadow: joystick.sprinting
                ? '0 0 24px rgba(255, 176, 64, 0.55)'
                : '0 8px 24px rgba(0,0,0,0.35)',
            }}
          />
          <div
            style={{
              ...joystickKnobStyle,
              left: joystick.originX + joystick.knobDx,
              top: joystick.originY + joystick.knobDy,
              background: joystick.sprinting
                ? 'rgba(255, 196, 96, 0.92)'
                : 'rgba(255, 255, 255, 0.85)',
            }}
          />
        </>
      )}

      <ActionButtons />
    </div>
  );
}

// ---------------- Action buttons ----------------

type ButtonDef = {
  key: string;
  label: string;
  size: number;
  bottom: number;
  right: number;
  kind: 'hold' | 'edge';
  holdName?: 'jump' | 'crouch' | 'firePrimary' | 'sprint';
  edgeName?: 'interact' | 'blockRemove' | 'blockPlace' | 'mat1' | 'mat2';
  tint?: string;
};

const PRIMARY_BUTTONS: ButtonDef[] = [
  { key: 'fire', label: 'FIRE', size: 96, bottom: 24, right: 24, kind: 'hold', holdName: 'firePrimary', tint: 'rgba(255, 92, 92, 0.88)' },
  { key: 'jump', label: 'JUMP', size: 76, bottom: 138, right: 28, kind: 'hold', holdName: 'jump', tint: 'rgba(120, 200, 255, 0.82)' },
  { key: 'sprint', label: 'RUN', size: 64, bottom: 218, right: 36, kind: 'hold', holdName: 'sprint', tint: 'rgba(255, 196, 96, 0.82)' },
  { key: 'crouch', label: 'CRCH', size: 64, bottom: 36, right: 140, kind: 'hold', holdName: 'crouch', tint: 'rgba(180, 220, 255, 0.82)' },
  { key: 'interact', label: 'USE', size: 64, bottom: 128, right: 140, kind: 'edge', edgeName: 'interact', tint: 'rgba(152, 255, 184, 0.88)' },
];

const SECONDARY_BUTTONS: ButtonDef[] = [
  { key: 'remove', label: 'Q', size: 52, bottom: 216, right: 150, kind: 'edge', edgeName: 'blockRemove', tint: 'rgba(255, 200, 120, 0.75)' },
  { key: 'place', label: 'F', size: 52, bottom: 216, right: 210, kind: 'edge', edgeName: 'blockPlace', tint: 'rgba(200, 255, 180, 0.75)' },
  { key: 'mat1', label: '1', size: 48, bottom: 276, right: 150, kind: 'edge', edgeName: 'mat1', tint: 'rgba(255, 255, 255, 0.75)' },
  { key: 'mat2', label: '2', size: 48, bottom: 276, right: 208, kind: 'edge', edgeName: 'mat2', tint: 'rgba(255, 255, 255, 0.75)' },
];

function ActionButtons() {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {PRIMARY_BUTTONS.map((btn) => (
        <TouchButton key={btn.key} def={btn} />
      ))}
      {expanded && SECONDARY_BUTTONS.map((btn) => (
        <TouchButton key={btn.key} def={btn} />
      ))}
      <div
        style={{
          ...expanderStyle,
          background: expanded ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)',
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
      >
        {expanded ? '×' : '···'}
      </div>
    </>
  );
}

function TouchButton({ def }: { def: ButtonDef }) {
  const pointerIdRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const begin = useCallback(() => {
    setActive(true);
    if (def.kind === 'hold' && def.holdName) {
      touchInputSource.setHold(def.holdName, true);
    } else if (def.kind === 'edge' && def.edgeName) {
      touchInputSource.pulseEdge(def.edgeName);
    }
  }, [def]);

  const end = useCallback(() => {
    setActive(false);
    if (def.kind === 'hold' && def.holdName) {
      touchInputSource.setHold(def.holdName, false);
    }
  }, [def]);

  return (
    <div
      style={{
        ...buttonBaseStyle,
        width: def.size,
        height: def.size,
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${def.bottom}px)`,
        right: `calc(env(safe-area-inset-right, 0px) + ${def.right}px)`,
        fontSize: def.size >= 80 ? 16 : def.size >= 60 ? 13 : 12,
        background: active
          ? def.tint ?? 'rgba(255,255,255,0.4)'
          : 'rgba(12, 18, 26, 0.55)',
        borderColor: active
          ? 'rgba(255,255,255,0.85)'
          : def.tint ?? 'rgba(255,255,255,0.35)',
        transform: active ? 'scale(0.94)' : 'scale(1)',
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (pointerIdRef.current !== null) return;
        pointerIdRef.current = e.pointerId;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        e.stopPropagation();
        begin();
      }}
      onPointerUp={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        e.stopPropagation();
        end();
      }}
      onPointerCancel={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        end();
      }}
      onLostPointerCapture={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        end();
      }}
    >
      {def.label}
    </div>
  );
}

// ---------------- Styles ----------------

const rootStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  pointerEvents: 'none',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
  WebkitTapHighlightColor: 'transparent',
  zIndex: 7,
  overflow: 'hidden',
};

const leftHalfStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: '50%',
  height: '100%',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const rightHalfStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 0,
  width: '50%',
  height: '100%',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const joystickPlaceholderStyle: CSSProperties = {
  position: 'absolute',
  left: 'calc(env(safe-area-inset-left, 0px) + 40px)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 44px)',
  width: 132,
  height: 132,
  borderRadius: '50%',
  border: '1px dashed rgba(255, 255, 255, 0.18)',
  background: 'rgba(255, 255, 255, 0.04)',
  pointerEvents: 'none',
};

const joystickRingStyle: CSSProperties = {
  position: 'absolute',
  width: JOYSTICK_INNER_RADIUS_PX * 2,
  height: JOYSTICK_INNER_RADIUS_PX * 2,
  marginLeft: -JOYSTICK_INNER_RADIUS_PX,
  marginTop: -JOYSTICK_INNER_RADIUS_PX,
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,0.35)',
  background: 'rgba(255, 255, 255, 0.06)',
  pointerEvents: 'none',
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
};

const joystickKnobStyle: CSSProperties = {
  position: 'absolute',
  width: 56,
  height: 56,
  marginLeft: -28,
  marginTop: -28,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.85)',
  border: '1px solid rgba(255,255,255,0.6)',
  pointerEvents: 'none',
  boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
};

const buttonBaseStyle: CSSProperties = {
  position: 'absolute',
  borderRadius: '50%',
  border: '2px solid rgba(255,255,255,0.35)',
  color: '#fff',
  fontFamily: 'monospace',
  fontWeight: 700,
  letterSpacing: '0.08em',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
  transition: 'transform 60ms ease, background 120ms ease, border-color 120ms ease',
};

const expanderStyle: CSSProperties = {
  position: 'absolute',
  right: 'calc(env(safe-area-inset-right, 0px) + 20px)',
  top: 'calc(env(safe-area-inset-top, 0px) + 20px)',
  width: 44,
  height: 44,
  borderRadius: 22,
  border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff',
  fontFamily: 'monospace',
  fontSize: 18,
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
};
