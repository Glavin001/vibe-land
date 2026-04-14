import { useState, type CSSProperties } from 'react';
import type { PracticeBotBehaviorKind, PracticeBotStats } from '../bots';

interface PracticeBotsPanelProps {
  /** Whether the panel should be visible at all (practice mode + connected). */
  visible: boolean;
  /** Current runtime stats. When the runtime has been cleaned up this is null. */
  stats: PracticeBotStats | null;
  onSetBotCount: (count: number) => void;
  onClear: () => void;
  onSetBehavior: (kind: PracticeBotBehaviorKind) => void;
  onSetMaxSpeed: (speed: number) => void;
}

const BEHAVIORS: Array<{ value: PracticeBotBehaviorKind; label: string; desc: string }> = [
  { value: 'harass', label: 'Chase me', desc: 'Bots path toward the local player' },
  { value: 'wander', label: 'Wander', desc: 'Bots roam random walkable points' },
  { value: 'hold', label: 'Hold anchor', desc: 'Bots stay near their spawn anchor' },
];

export function PracticeBotsPanel({
  visible,
  stats,
  onSetBotCount,
  onClear,
  onSetBehavior,
  onSetMaxSpeed,
}: PracticeBotsPanelProps) {
  const [open, setOpen] = useState(false);
  if (!visible) return null;

  const count = stats?.bots ?? 0;
  const behavior = stats?.behavior ?? 'harass';
  const maxSpeed = stats?.maxSpeed ?? 5.5;

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
              type="range"
              min={0}
              max={16}
              step={1}
              value={count}
              onChange={(event) => onSetBotCount(Number(event.target.value))}
              style={sliderStyle}
            />
            <input
              type="number"
              min={0}
              max={32}
              step={1}
              value={count}
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
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={maxSpeed}
              onChange={(event) => onSetMaxSpeed(Number(event.target.value))}
              style={sliderStyle}
            />
            <span style={valueStyle}>{maxSpeed.toFixed(1)} m/s</span>
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
          {stats && (
            <div style={footerStyle}>
              navmesh: {stats.navTriangles.toLocaleString()} tris · bots rendered as remote players
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
  minWidth: 280,
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
