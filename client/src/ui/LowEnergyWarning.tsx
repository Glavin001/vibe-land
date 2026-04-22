import { type CSSProperties } from 'react';

const LOW_ENERGY_THRESHOLD = 250;

type Props = {
  energy: number;
  visible: boolean;
};

export function LowEnergyWarning({ energy, visible }: Props) {
  if (!visible || energy <= 0 || energy >= LOW_ENERGY_THRESHOLD) return null;

  return (
    <>
      <style>{`
        @keyframes energy-warn-pulse {
          0%, 100% { opacity: 0.9; }
          50% { opacity: 1; box-shadow: 0 0 18px 4px rgba(243,192,66,0.45); }
        }
      `}</style>
      <div style={containerStyle}>
        <span style={titleStyle}>ENERGY RUNNING LOW</span>
        <span style={bodyStyle}>
          Collect the glowing yellow batteries on the ground to recharge
        </span>
      </div>
    </>
  );
}

const containerStyle: CSSProperties = {
  position: 'absolute',
  bottom: 72,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  padding: '10px 18px',
  background: 'rgba(20, 14, 0, 0.82)',
  border: '1px solid rgba(243,192,66,0.6)',
  borderRadius: 8,
  color: '#f3c042',
  font: '13px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
  pointerEvents: 'none',
  userSelect: 'none',
  zIndex: 20,
  whiteSpace: 'nowrap',
  animation: 'energy-warn-pulse 1.4s ease-in-out infinite',
};

const titleStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: 1.5,
};

const bodyStyle: CSSProperties = {
  fontWeight: 400,
  fontSize: 12,
  opacity: 0.85,
};
