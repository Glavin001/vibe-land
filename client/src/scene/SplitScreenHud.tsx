import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { CrosshairAimState } from './aimTargeting';
import { computeSplitScreenViewports } from './SplitScreenRenderer';
import type { GuestHudMap } from './PracticeGuestPlayer';

const ENERGY_BAR_NOMINAL_MAX = 2000;
const HP_MAX = 100;

export interface SplitScreenHudPlayer {
  slotId: number;
  /** `null` for the primary local player (slot 0), human sim id otherwise. */
  humanId: number | null;
  label: string;
}

interface SplitScreenHudProps {
  /** Ordered player list; slot 0 first, then guests in slot-id order. */
  players: SplitScreenHudPlayer[];
  /** CSS selector (or ref) for the canvas element whose rect we tile over. */
  canvasSelector?: string;
  primaryHp: number;
  primaryEnergy: number;
  /** Whether the primary slot is connected / should show its HUD. */
  primaryVisible: boolean;
  crosshairState: CrosshairAimState;
  guestHudRef: RefObject<GuestHudMap>;
}

type ViewportCssRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function useCanvasRect(selector: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let cancelled = false;
    let current: DOMRect | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let observer: ResizeObserver | null = null;
    let pollId: number | null = null;
    const update = () => {
      if (!canvas) return;
      const next = canvas.getBoundingClientRect();
      if (
        current == null
        || Math.abs(current.left - next.left) > 0.5
        || Math.abs(current.top - next.top) > 0.5
        || Math.abs(current.width - next.width) > 0.5
        || Math.abs(current.height - next.height) > 0.5
      ) {
        current = next;
        if (!cancelled) setRect(next);
      }
    };
    const bind = () => {
      const el = document.querySelector<HTMLCanvasElement>(selector);
      if (!el) return false;
      canvas = el;
      observer = new ResizeObserver(update);
      observer.observe(el);
      update();
      return true;
    };
    if (!bind()) {
      pollId = window.setInterval(() => {
        if (bind() && pollId != null) {
          window.clearInterval(pollId);
          pollId = null;
        }
      }, 50);
    }
    window.addEventListener('resize', update);
    return () => {
      cancelled = true;
      if (pollId != null) window.clearInterval(pollId);
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [selector]);
  return rect;
}

/**
 * Forces the component to re-render every animation frame so the per-guest
 * HUD values (which live in a ref, not React state) stay fresh.
 */
function useAnimationFrameTick(enabled: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const loop = () => {
      setTick((t) => (t + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
}

/**
 * DOM overlay rendered outside the Canvas that draws one HP/EN meter bar plus
 * a crosshair into each split-screen viewport. It computes per-viewport CSS
 * rects by mirroring {@link computeSplitScreenViewports} on the canvas's
 * client rect.
 *
 * Slot 0 reads HP/energy directly from props (filtered from the main network
 * snapshot). Guest slots read from `guestHudRef` which is populated each frame
 * by {@link PracticeGuestPlayer}.
 */
export function SplitScreenHud({
  players,
  canvasSelector = '[data-testid="game-canvas"]',
  primaryHp,
  primaryEnergy,
  primaryVisible,
  crosshairState,
  guestHudRef,
}: SplitScreenHudProps) {
  const rect = useCanvasRect(canvasSelector);
  useAnimationFrameTick(players.length > 1);
  const rootRef = useRef<HTMLDivElement>(null);

  if (!rect || players.length === 0) return null;

  // Compute in CSS pixels. Viewports from `computeSplitScreenViewports` use
  // OpenGL bottom-left origin; convert to CSS top-left here.
  const viewports = computeSplitScreenViewports(players.length, rect.width, rect.height);
  const cssRects: ViewportCssRect[] = viewports.map((vp) => ({
    left: vp.x,
    top: rect.height - vp.y - vp.h,
    width: vp.w,
    height: vp.h,
  }));

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    >
      {players.map((player, i) => {
        const vpRect = cssRects[i];
        if (!vpRect) return null;
        let hp = 0;
        let energy = 0;
        let alive = true;
        let visible = true;
        if (player.humanId == null) {
          hp = primaryHp;
          energy = primaryEnergy;
          visible = primaryVisible;
        } else {
          const entry = guestHudRef.current?.get(player.humanId);
          hp = entry?.hp ?? 0;
          energy = entry?.energy ?? 0;
          alive = entry?.alive ?? true;
          visible = entry != null;
        }
        return (
          <ViewportHud
            key={player.slotId}
            rect={vpRect}
            label={player.label}
            hp={hp}
            energy={energy}
            alive={alive}
            visible={visible}
            crosshairState={player.humanId == null ? crosshairState : 'idle'}
          />
        );
      })}
    </div>
  );
}

interface ViewportHudProps {
  rect: ViewportCssRect;
  label: string;
  hp: number;
  energy: number;
  alive: boolean;
  visible: boolean;
  crosshairState: CrosshairAimState;
}

function ViewportHud({ rect, label, hp, energy, alive, visible, crosshairState }: ViewportHudProps) {
  const crosshairColor =
    crosshairState === 'head'
      ? 'rgba(255, 36, 36, 0.98)'
      : crosshairState === 'body'
        ? 'rgba(255, 92, 92, 0.96)'
        : 'rgba(255, 255, 255, 0.9)';
  const crosshairGlow =
    crosshairState === 'idle'
      ? 'rgba(255, 255, 255, 0.18)'
      : crosshairState === 'head'
        ? 'rgba(255, 48, 48, 0.55)'
        : 'rgba(255, 96, 96, 0.45)';

  const hpRatio = Math.max(0, Math.min(1, hp / HP_MAX));
  const energyRatio = Math.max(0, Math.min(1, energy / ENERGY_BAR_NOMINAL_MAX));
  const energyLabel = energy >= ENERGY_BAR_NOMINAL_MAX ? `${Math.floor(energy)}+` : `${Math.floor(energy)}`;

  return (
    <div
      style={{
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {/* Crosshair at viewport center */}
      {visible && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 18,
            height: 18,
            transform: 'translate(-50%, -50%)',
            filter: `drop-shadow(0 0 6px ${crosshairGlow})`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              width: 2,
              height: '100%',
              transform: 'translateX(-50%)',
              background: crosshairColor,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              width: '100%',
              height: 2,
              transform: 'translateY(-50%)',
              background: crosshairColor,
            }}
          />
        </div>
      )}

      {/* HP/EN meters pinned to the bottom-left of this viewport */}
      {visible && (
        <div style={meterContainerStyle}>
          <div style={playerLabelStyle}>{label}{!alive ? ' (DOWN)' : ''}</div>
          <MeterRow
            label="HP"
            ratio={hpRatio}
            valueText={`${Math.floor(hp)} / ${HP_MAX}`}
            fill="#d0463c"
            track="#1a0808"
          />
          <MeterRow
            label="EN"
            ratio={energyRatio}
            valueText={energyLabel}
            fill="#f3c042"
            track="#1a1408"
          />
        </div>
      )}
    </div>
  );
}

function MeterRow({
  label,
  ratio,
  valueText,
  fill,
  track,
}: {
  label: string;
  ratio: number;
  valueText: string;
  fill: string;
  track: string;
}) {
  return (
    <div style={rowStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{ ...trackStyle, background: track }}>
        <div
          style={{
            ...fillStyle,
            width: `${Math.round(ratio * 100)}%`,
            background: fill,
          }}
        />
        <div style={valueStyle}>{valueText}</div>
      </div>
    </div>
  );
}

const meterContainerStyle: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 6,
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#fff',
  font: '11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  userSelect: 'none',
  minWidth: 180,
};

const playerLabelStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: 0.5,
  opacity: 0.85,
  paddingLeft: 2,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const labelStyle: CSSProperties = {
  width: 20,
  textAlign: 'right',
  fontWeight: 700,
  letterSpacing: 0.5,
  opacity: 0.85,
};

const trackStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 12,
  borderRadius: 3,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.15)',
};

const fillStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  transition: 'width 80ms linear',
};

const valueStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontSize: 10,
  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
};
