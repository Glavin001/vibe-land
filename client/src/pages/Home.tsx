import type { CSSProperties } from 'react';

const shellStyle: CSSProperties = {
  minHeight: '100%',
  background:
    'radial-gradient(circle at top, rgba(93, 215, 255, 0.14), transparent 32%), linear-gradient(180deg, #08111d 0%, #04070d 100%)',
  color: '#edf6ff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px',
};

const panelStyle: CSSProperties = {
  width: 'min(1040px, 100%)',
  background: 'rgba(6, 12, 20, 0.86)',
  border: '1px solid rgba(110, 190, 255, 0.2)',
  borderRadius: 28,
  boxShadow: '0 30px 90px rgba(0, 0, 0, 0.45)',
  padding: '40px',
};

const cardStyle: CSSProperties = {
  flex: '1 1 280px',
  minWidth: 0,
  display: 'block',
  textDecoration: 'none',
  color: 'inherit',
  borderRadius: 20,
  border: '1px solid rgba(145, 198, 255, 0.18)',
  background: 'linear-gradient(180deg, rgba(18, 29, 45, 0.95) 0%, rgba(8, 14, 23, 0.95) 100%)',
  padding: '24px',
};

export function HomePage() {
  return (
    <div style={shellStyle}>
      <div style={panelStyle}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ letterSpacing: '0.28em', fontSize: 12, textTransform: 'uppercase', color: '#79baf5' }}>
            vibe-land
          </div>
          <h1 style={{ fontSize: 'clamp(44px, 8vw, 88px)', lineHeight: 0.95, margin: '12px 0 14px', fontWeight: 700 }}>
            One build. Two ways to play.
          </h1>
          <p style={{ maxWidth: 760, fontSize: 18, lineHeight: 1.6, color: 'rgba(237, 246, 255, 0.74)' }}>
            Multiplayer and the firing range now ship in the same web app. Use direct links for fast entry, or start here.
          </p>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 18 }}>
          <a href="/play" style={cardStyle}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#87d6ff', marginBottom: 10 }}>
              /play
            </div>
            <h2 style={{ margin: 0, fontSize: 30 }}>Multiplayer</h2>
            <p style={{ margin: '12px 0 18px', color: 'rgba(237, 246, 255, 0.74)', lineHeight: 1.6 }}>
              Join the networked game. WebTransport is preferred, with WebSocket fallback when needed.
            </p>
            <div style={{ color: '#fff5b1', fontSize: 14 }}>Best when the game backend is reachable from this browser.</div>
          </a>

          <a href="/practice" style={cardStyle}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.18em', color: '#87d6ff', marginBottom: 10 }}>
              /practice
            </div>
            <h2 style={{ margin: 0, fontSize: 30 }}>Firing Range</h2>
            <p style={{ margin: '12px 0 18px', color: 'rgba(237, 246, 255, 0.74)', lineHeight: 1.6 }}>
              Run the local WASM simulation in-browser with no Rust server required. This is the current single-player mode.
            </p>
            <div style={{ color: '#b9ffc3', fontSize: 14 }}>Works offline after assets are cached.</div>
          </a>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 14, color: 'rgba(237, 246, 255, 0.62)' }}>
          <a href="/stats" style={{ color: '#9cd4ff' }}>Server stats</a>
          <a href="/loadtest" style={{ color: '#9cd4ff' }}>Load test</a>
        </div>
      </div>
    </div>
  );
}
