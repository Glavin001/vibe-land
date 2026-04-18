import { type CSSProperties } from 'react';

type EnergyBarProps = {
  hp: number;
  energy: number;
  visible: boolean;
};

const ENERGY_BAR_NOMINAL_MAX = 2000;
const HP_MAX = 100;

export function EnergyBar({ hp, energy, visible }: EnergyBarProps) {
  if (!visible) return null;

  const hpRatio = Math.max(0, Math.min(1, hp / HP_MAX));
  const energyRatio = Math.max(0, Math.min(1, energy / ENERGY_BAR_NOMINAL_MAX));
  const energyLabel = energy >= ENERGY_BAR_NOMINAL_MAX ? `${Math.floor(energy)}+` : `${Math.floor(energy)}`;

  return (
    <div style={containerStyle}>
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

const containerStyle: CSSProperties = {
  position: 'absolute',
  left: 16,
  bottom: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  background: 'rgba(0,0,0,0.35)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  color: '#fff',
  font: '12px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  pointerEvents: 'none',
  userSelect: 'none',
  zIndex: 15,
  minWidth: 220,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const labelStyle: CSSProperties = {
  width: 24,
  textAlign: 'right',
  fontWeight: 700,
  letterSpacing: 0.5,
  opacity: 0.85,
};

const trackStyle: CSSProperties = {
  position: 'relative',
  flex: 1,
  height: 14,
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
  fontSize: 11,
  textShadow: '0 1px 2px rgba(0,0,0,0.8)',
};
