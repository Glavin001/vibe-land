import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  BTN_BACK,
  BTN_FORWARD,
  BTN_JUMP,
  BTN_LEFT,
  BTN_RIGHT,
  BTN_SPRINT,
} from '../net/protocol';

const JOYSTICK_RADIUS = 44;
const MOVE_THRESHOLD = 0.28;

type MobileControlsProps = {
  onLookDelta: (dx: number, dy: number) => void;
  onMoveButtonsChange: (buttons: number) => void;
  onActionButtonChange: (mask: number, active: boolean) => void;
};

type StickState = {
  x: number;
  y: number;
  active: boolean;
};

export function MobileControls({
  onLookDelta,
  onMoveButtonsChange,
  onActionButtonChange,
}: MobileControlsProps) {
  const joystickRef = useRef<HTMLDivElement>(null);
  const movePointerIdRef = useRef<number | null>(null);
  const lookPointerIdRef = useRef<number | null>(null);
  const lookLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [stick, setStick] = useState<StickState>({ x: 0, y: 0, active: false });

  const updateMove = useCallback((clientX: number, clientY: number) => {
    const bounds = joystickRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const centerX = bounds.left + bounds.width / 2;
    const centerY = bounds.top + bounds.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.hypot(dx, dy);
    const scale = distance > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / distance : 1;
    const clampedX = dx * scale;
    const clampedY = dy * scale;
    const normalizedX = clampedX / JOYSTICK_RADIUS;
    const normalizedY = clampedY / JOYSTICK_RADIUS;

    let buttons = 0;
    if (normalizedY < -MOVE_THRESHOLD) buttons |= BTN_FORWARD;
    if (normalizedY > MOVE_THRESHOLD) buttons |= BTN_BACK;
    if (normalizedX < -MOVE_THRESHOLD) buttons |= BTN_LEFT;
    if (normalizedX > MOVE_THRESHOLD) buttons |= BTN_RIGHT;

    onMoveButtonsChange(buttons);
    setStick({ x: clampedX, y: clampedY, active: true });
  }, [onMoveButtonsChange]);

  const resetMove = useCallback(() => {
    movePointerIdRef.current = null;
    onMoveButtonsChange(0);
    setStick({ x: 0, y: 0, active: false });
  }, [onMoveButtonsChange]);

  const handleJoystickPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointerIdRef.current !== null) return;
    movePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    // #region agent log
    fetch('http://127.0.0.1:7573/ingest/57b4fbd5-6dde-4eb5-b85a-6674ac4543c0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'83ac5f'},body:JSON.stringify({sessionId:'83ac5f',runId:'cadence-pre',hypothesisId:'H29',location:'client/src/scene/MobileControls.tsx:72',message:'mobile joystick engaged',data:{pointerType:e.pointerType,clientX:e.clientX,clientY:e.clientY},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    updateMove(e.clientX, e.clientY);
  }, [updateMove]);

  const handleJoystickPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointerIdRef.current !== e.pointerId) return;
    updateMove(e.clientX, e.clientY);
  }, [updateMove]);

  const handleJoystickPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (movePointerIdRef.current !== e.pointerId) return;
    resetMove();
  }, [resetMove]);

  const handleLookPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (lookPointerIdRef.current !== null) return;
    lookPointerIdRef.current = e.pointerId;
    lookLastPointRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleLookPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (lookPointerIdRef.current !== e.pointerId || !lookLastPointRef.current) return;
    const dx = e.clientX - lookLastPointRef.current.x;
    const dy = e.clientY - lookLastPointRef.current.y;
    lookLastPointRef.current = { x: e.clientX, y: e.clientY };
    onLookDelta(dx, dy);
  }, [onLookDelta]);

  const resetLook = useCallback((pointerId: number) => {
    if (lookPointerIdRef.current !== pointerId) return;
    lookPointerIdRef.current = null;
    lookLastPointRef.current = null;
  }, []);

  return (
    <div style={overlayStyle}>
      <div
        style={lookAreaStyle}
        onPointerDown={handleLookPointerDown}
        onPointerMove={handleLookPointerMove}
        onPointerUp={(e) => resetLook(e.pointerId)}
        onPointerCancel={(e) => resetLook(e.pointerId)}
        onLostPointerCapture={(e) => resetLook(e.pointerId)}
      />

      <div
        ref={joystickRef}
        style={joystickBaseStyle}
        onPointerDown={handleJoystickPointerDown}
        onPointerMove={handleJoystickPointerMove}
        onPointerUp={handleJoystickPointerUp}
        onPointerCancel={handleJoystickPointerUp}
        onLostPointerCapture={handleJoystickPointerUp}
      >
        <div
          style={{
            ...joystickKnobStyle,
            transform: `translate(calc(-50% + ${stick.x}px), calc(-50% + ${stick.y}px))`,
            opacity: stick.active ? 1 : 0.92,
          }}
        />
      </div>

      <div style={buttonColumnStyle}>
        <ActionButton
          label="SPRINT"
          onActiveChange={(active) => onActionButtonChange(BTN_SPRINT, active)}
        />
        <ActionButton
          label="JUMP"
          onActiveChange={(active) => onActionButtonChange(BTN_JUMP, active)}
        />
      </div>
    </div>
  );
}

type ActionButtonProps = {
  label: string;
  onActiveChange: (active: boolean) => void;
};

function ActionButton({ label, onActiveChange }: ActionButtonProps) {
  const pointerIdRef = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const setPressed = useCallback((next: boolean) => {
    pointerIdRef.current = next ? pointerIdRef.current : null;
    setActive(next);
    onActiveChange(next);
  }, [onActiveChange]);

  return (
    <button
      type="button"
      style={{
        ...actionButtonStyle,
        transform: active ? 'scale(0.96)' : 'scale(1)',
        background: active ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)',
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (pointerIdRef.current !== null) return;
        pointerIdRef.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressed(true);
      }}
      onPointerUp={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        setPressed(false);
      }}
      onPointerCancel={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        setPressed(false);
      }}
      onLostPointerCapture={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        setPressed(false);
      }}
    >
      {label}
    </button>
  );
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
};

const lookAreaStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  left: '48%',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const joystickBaseStyle: CSSProperties = {
  position: 'absolute',
  left: 'calc(env(safe-area-inset-left) + 20px)',
  bottom: 'calc(env(safe-area-inset-bottom) + 24px)',
  width: 132,
  height: 132,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.08)',
  boxShadow: '0 10px 30px rgba(0,0,0,0.28)',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const joystickKnobStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  width: 64,
  height: 64,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.25)',
  background: 'rgba(255,255,255,0.2)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
};

const buttonColumnStyle: CSSProperties = {
  position: 'absolute',
  right: 'calc(env(safe-area-inset-right) + 20px)',
  bottom: 'calc(env(safe-area-inset-bottom) + 24px)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 14,
  pointerEvents: 'none',
};

const actionButtonStyle: CSSProperties = {
  minWidth: 92,
  height: 56,
  padding: '0 18px',
  borderRadius: 28,
  border: '1px solid rgba(255,255,255,0.25)',
  color: '#fff',
  font: '600 14px monospace',
  letterSpacing: '0.08em',
  pointerEvents: 'auto',
  touchAction: 'none',
};
