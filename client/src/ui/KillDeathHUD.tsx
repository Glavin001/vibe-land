import { useLocalKD } from './scoreboardStore';

export function KillDeathHUD() {
  const { kills, deaths } = useLocalKD();
  return (
    <div
      data-testid="kd-hud"
      style={{
        position: 'absolute',
        top: 42,
        left: 8,
        zIndex: 5,
        background: 'rgba(0,0,0,0.6)',
        padding: '4px 10px',
        borderRadius: 4,
        fontSize: 13,
        fontFamily: 'monospace',
        pointerEvents: 'none',
        color: 'rgba(255,255,255,0.92)',
        letterSpacing: '0.02em',
      }}
    >
      <span style={{ color: 'rgba(134, 239, 172, 0.95)' }}>K</span>
      <span> {kills}</span>
      <span style={{ opacity: 0.5, margin: '0 6px' }}>·</span>
      <span style={{ color: 'rgba(252, 165, 165, 0.95)' }}>D</span>
      <span> {deaths}</span>
    </div>
  );
}
