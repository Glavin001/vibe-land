import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PracticeBotBehaviorKind, PracticeBotStats } from '../bots';

interface PracticeBotsPanelProps {
  /** Whether the panel should be visible at all (practice mode + connected). */
  visible: boolean;
  /** Current runtime stats. When the runtime has been cleaned up this is null. */
  stats: PracticeBotStats | null;
  /** Whether the in-scene bot debug overlay is currently rendering. */
  debugOverlay: boolean;
  onSetBotCount: (count: number) => void;
  onClear: () => void;
  onSetBehavior: (kind: PracticeBotBehaviorKind) => void;
  onSetMaxSpeed: (speed: number) => void;
  onToggleDebugOverlay: (value: boolean) => void;
  onSetUseVehicles: (value: boolean) => void;
}

const BEHAVIORS: Array<{ value: PracticeBotBehaviorKind; label: string; desc: string }> = [
  { value: 'harass', label: 'Chase me', desc: 'Bots path toward the local player' },
  { value: 'wander', label: 'Wander', desc: 'Bots roam random walkable points' },
  { value: 'hold', label: 'Hold anchor', desc: 'Bots stay near their spawn anchor' },
];

/**
 * Native ranges and number inputs are notoriously fragile when used as
 * fully controlled React inputs — a re-render that lands mid-drag can
 * snap the slider back to the last committed value, making it feel
 * "stuck". To avoid that, the inputs in this panel are **uncontrolled**:
 *
 * - `defaultValue` initializes them once.
 * - `onInput` pushes drag-time updates straight to the runtime via the
 *   parent callback (no React state in the loop).
 * - A small `useEffect` writes the latest external value into the input
 *   via a ref *only* when the user is not currently dragging. That way
 *   external state changes (e.g. another control or a programmatic
 *   reset) still update the input, but a controlled-component fight
 *   never happens during interactive drags.
 */
function useDraggableInputSync(
  externalValue: number,
): readonly [
  React.RefObject<HTMLInputElement>,
  () => void,
  () => void,
] {
  const ref = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (draggingRef.current) return;
    if (!ref.current) return;
    const next = String(externalValue);
    if (ref.current.value !== next) ref.current.value = next;
  }, [externalValue]);
  const onPointerDown = () => {
    draggingRef.current = true;
  };
  const onPointerUp = () => {
    draggingRef.current = false;
  };
  return [ref, onPointerDown, onPointerUp];
}

export function PracticeBotsPanel({
  visible,
  stats,
  debugOverlay,
  onSetBotCount,
  onClear,
  onSetBehavior,
  onSetMaxSpeed,
  onToggleDebugOverlay,
  onSetUseVehicles,
}: PracticeBotsPanelProps) {
  const [open, setOpen] = useState(false);

  const count = stats?.bots ?? 0;
  const behavior = stats?.behavior ?? 'harass';
  const maxSpeed = stats?.maxSpeed ?? 3.0;
  const useVehicles = stats?.useVehicles ?? false;

  const [countSliderRef, countDragStart, countDragEnd] = useDraggableInputSync(count);
  const [countNumberRef, , ] = useDraggableInputSync(count);
  const [speedSliderRef, speedDragStart, speedDragEnd] = useDraggableInputSync(maxSpeed);
  const [speedNumberRef, , ] = useDraggableInputSync(maxSpeed);

  if (!visible) return null;

  return (
    <div style={containerStyle}>
      <button
        type="button"
        style={toggleButtonStyle}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '▼ Bots' : '▶ Bots'} · {count}
      </button>
      {open && (
        <div style={panelStyle}>
          <div style={rowStyle}>
            <label style={labelStyle}>Count</label>
            <input
              ref={countSliderRef}
              type="range"
              min={0}
              max={16}
              step={1}
              defaultValue={count}
              onInput={(event) =>
                onSetBotCount(Number((event.target as HTMLInputElement).value))
              }
              onPointerDown={countDragStart}
              onPointerUp={countDragEnd}
              onPointerCancel={countDragEnd}
              style={sliderStyle}
            />
            <input
              ref={countNumberRef}
              type="number"
              min={0}
              max={32}
              step={1}
              defaultValue={count}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(next)) onSetBotCount(next);
              }}
              style={numberInputStyle}
            />
          </div>
          <div style={rowStyle}>
            <label style={labelStyle}>Speed</label>
            <input
              ref={speedSliderRef}
              type="range"
              min={0.5}
              max={8}
              step={0.25}
              defaultValue={maxSpeed}
              onInput={(event) =>
                onSetMaxSpeed(Number((event.target as HTMLInputElement).value))
              }
              onPointerDown={speedDragStart}
              onPointerUp={speedDragEnd}
              onPointerCancel={speedDragEnd}
              style={sliderStyle}
            />
            <input
              ref={speedNumberRef}
              type="number"
              min={0.5}
              max={12}
              step={0.25}
              defaultValue={maxSpeed}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next > 0) onSetMaxSpeed(next);
              }}
              style={numberInputStyle}
            />
            <span style={unitStyle}>m/s</span>
          </div>
          <div style={{ ...rowStyle, alignItems: 'flex-start' }}>
            <label style={labelStyle}>Behavior</label>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 4 }}>
              {BEHAVIORS.map((option) => (
                <label key={option.value} style={radioLabelStyle}>
                  <input
                    type="radio"
                    name="practice-bot-behavior"
                    value={option.value}
                    checked={behavior === option.value}
                    onChange={() => onSetBehavior(option.value)}
                  />
                  <span>
                    <span style={{ fontWeight: 600 }}>{option.label}</span>
                    <span style={descStyle}> — {option.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <div style={rowStyle}>
            <label style={labelStyle}>Vehicles</label>
            <label style={toggleLabelStyle}>
              <input
                type="checkbox"
                checked={useVehicles}
                onChange={(event) => onSetUseVehicles(event.target.checked)}
              />
              <span>bots can drive vehicles to reach targets</span>
            </label>
          </div>
          <div style={rowStyle}>
            <label style={labelStyle}>Debug</label>
            <label style={toggleLabelStyle}>
              <input
                type="checkbox"
                checked={debugOverlay}
                onChange={(event) => onToggleDebugOverlay(event.target.checked)}
              />
              <span>show path / target / state in scene</span>
            </label>
          </div>
          <div style={rowStyle}>
            <button type="button" style={actionButtonStyle} onClick={() => onSetBotCount(count + 1)}>
              + Add bot
            </button>
            <button
              type="button"
              style={{ ...actionButtonStyle, ...dangerButtonStyle }}
              onClick={onClear}
              disabled={count === 0}
            >
              Clear
            </button>
          </div>
          <div style={liveValueStyle}>
            <span>{count} bots</span>
            <span>·</span>
            <span>{maxSpeed.toFixed(2)} m/s</span>
            <span>·</span>
            <span>{behavior}</span>
          </div>
          {stats && (
            <div style={footerStyle}>
              navmesh: {stats.navTriangles.toLocaleString()} tris · bots are real players in WASM
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const containerStyle: CSSProperties = {
  position: 'absolute',
  top: 48,
  right: 8,
  zIndex: 12,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  fontFamily: 'system-ui, sans-serif',
  color: '#fff',
};

const toggleButtonStyle: CSSProperties = {
  background: 'rgba(0, 0, 0, 0.6)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#fff',
  padding: '6px 12px',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
  minWidth: 96,
  textAlign: 'left',
};

const panelStyle: CSSProperties = {
  background: 'rgba(0, 0, 0, 0.72)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  // Wide enough that the slider has comfortable drag distance after the
  // label, number input, and unit suffix take their share. Cramped
  // sliders feel "broken" — they hit-test poorly.
  minWidth: 360,
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
};

const labelStyle: CSSProperties = {
  minWidth: 60,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'rgba(255,255,255,0.65)',
  fontSize: 11,
};

const sliderStyle: CSSProperties = {
  flex: 1,
  accentColor: '#6bd8ff',
};

const numberInputStyle: CSSProperties = {
  width: 56,
  background: 'rgba(255,255,255,0.08)',
  color: '#fff',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 3,
  padding: '2px 4px',
  fontSize: 12,
  textAlign: 'right',
};

const unitStyle: CSSProperties = {
  fontSize: 11,
  color: 'rgba(255,255,255,0.55)',
  minWidth: 28,
};

const toggleLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: 1,
  fontSize: 12,
  color: 'rgba(255,255,255,0.85)',
  cursor: 'pointer',
};

const liveValueStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  fontSize: 11,
  color: 'rgba(255,255,255,0.7)',
  paddingTop: 4,
  borderTop: '1px dashed rgba(255,255,255,0.08)',
  fontVariantNumeric: 'tabular-nums',
};

const valueStyle: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  minWidth: 56,
  textAlign: 'right',
};

const radioLabelStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  cursor: 'pointer',
};

const descStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.55)',
  fontSize: 11,
};

const actionButtonStyle: CSSProperties = {
  flex: 1,
  background: 'rgba(107, 216, 255, 0.18)',
  border: '1px solid rgba(107, 216, 255, 0.45)',
  color: '#edf9ff',
  padding: '6px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};

const dangerButtonStyle: CSSProperties = {
  background: 'rgba(255, 107, 107, 0.18)',
  border: '1px solid rgba(255, 107, 107, 0.45)',
  color: '#ffeaea',
};

const footerStyle: CSSProperties = {
  color: 'rgba(255,255,255,0.45)',
  fontSize: 11,
  paddingTop: 4,
  borderTop: '1px solid rgba(255,255,255,0.08)',
};
