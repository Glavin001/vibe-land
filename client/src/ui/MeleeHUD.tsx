import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { subscribeMeleeFeedback, type MeleeFeedbackEvent } from './meleeFeedback';

type MeleeHUDProps = {
  visible: boolean;
};

const SWING_FLASH_MS = 280;
const HIT_FLASH_MS = 360;

type HUDState = {
  lastEvent: MeleeFeedbackEvent | null;
  nowMs: number;
};

export function MeleeHUD({ visible }: MeleeHUDProps) {
  const [state, setState] = useState<HUDState>({ lastEvent: null, nowMs: performance.now() });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return subscribeMeleeFeedback((event) => {
      setState({ lastEvent: event, nowMs: performance.now() });
    });
  }, []);

  useEffect(() => {
    if (!state.lastEvent) return;
    const tick = () => {
      const now = performance.now();
      setState((prev) => (prev.lastEvent ? { ...prev, nowMs: now } : prev));
      const elapsed = now - state.lastEvent!.sentAtMs;
      // Keep ticking until the cooldown bar is fully drained and flashes have finished.
      const cooldownDone = elapsed >= state.lastEvent!.cooldownMs;
      const flashDone = elapsed >= Math.max(SWING_FLASH_MS, HIT_FLASH_MS);
      if (cooldownDone && flashDone) {
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state.lastEvent]);

  if (!visible) return null;

  const event = state.lastEvent;
  const elapsed = event ? Math.max(0, state.nowMs - event.sentAtMs) : 0;
  const cooldownRatio = event ? Math.max(0, 1 - elapsed / event.cooldownMs) : 0;
  const swingActive = event !== null && elapsed < SWING_FLASH_MS;
  const hitActive = event !== null && event.predictedHit && elapsed < HIT_FLASH_MS;
  const swingAlpha = swingActive ? 1 - elapsed / SWING_FLASH_MS : 0;
  const hitAlpha = hitActive ? 1 - elapsed / HIT_FLASH_MS : 0;

  return (
    <div style={containerStyle}>
      {hitActive && (
        <div
          style={{
            ...hitMarkerStyle,
            opacity: hitAlpha,
            transform: `translate(-50%, -50%) scale(${1 + (1 - hitAlpha) * 0.4})`,
          }}
        >
          <svg width="34" height="34" viewBox="0 0 34 34">
            <path
              d="M5 5 L12 12 M29 5 L22 12 M5 29 L12 22 M29 29 L22 22"
              stroke="#ff5050"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </div>
      )}
      {swingActive && (
        <div
          style={{
            ...swingLabelStyle,
            opacity: swingAlpha,
            color: event?.predictedHit ? '#ffeaa0' : 'rgba(255,255,255,0.85)',
          }}
        >
          SWING
        </div>
      )}
      {event !== null && cooldownRatio > 0 && (
        <div style={cooldownTrackStyle}>
          <div
            style={{
              ...cooldownFillStyle,
              width: `${cooldownRatio * 100}%`,
              background:
                cooldownRatio > 0.66
                  ? 'linear-gradient(90deg, #ffb14a, #ff6a3d)'
                  : cooldownRatio > 0.33
                    ? 'linear-gradient(90deg, #ffd466, #ffb14a)'
                    : 'linear-gradient(90deg, #cfe9ff, #a5ffcf)',
            }}
          />
        </div>
      )}
    </div>
  );
}

const containerStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, 22px)',
  pointerEvents: 'none',
  zIndex: 7,
  width: 120,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  userSelect: 'none',
};

const swingLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.24em',
  textTransform: 'uppercase',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  textShadow: '0 1px 3px rgba(0,0,0,0.7)',
  transition: 'opacity 60ms linear',
};

const cooldownTrackStyle: CSSProperties = {
  width: 96,
  height: 4,
  borderRadius: 999,
  background: 'rgba(0,0,0,0.45)',
  border: '1px solid rgba(255,255,255,0.15)',
  overflow: 'hidden',
};

const cooldownFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 999,
  transition: 'width 30ms linear',
};

const hitMarkerStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: -28,
  transformOrigin: 'center',
  filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.8))',
  transition: 'opacity 60ms linear, transform 60ms linear',
};
