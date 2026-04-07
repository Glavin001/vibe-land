import { useState, useCallback } from 'react';
import { detectTouchControls } from './device';
import { GameScene } from './scene/GameScene';

export function App() {
  const [touchMode] = useState(detectTouchControls);
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(0);
  const [status, setStatus] = useState(() => (touchMode ? 'Tap to join' : 'Click to join'));

  const handleConnect = useCallback(() => {
    setConnected(true);
    setStatus('Connecting...');
  }, []);

  const handleWelcome = useCallback((id: number) => {
    setPlayerId(id);
    setStatus(
      touchMode
        ? `Player #${id} — move with the left thumb, swipe right to look, jump/sprint on the right`
        : `Player #${id} — WASD move, mouse look, Space jump`,
    );
  }, [touchMode]);

  const handleDisconnect = useCallback(() => {
    setStatus(touchMode ? 'Disconnected — tap to rejoin' : 'Disconnected — click to rejoin');
    setConnected(false);
    setPlayerId(0);
  }, [touchMode]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {!connected && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 10,
            background: 'rgba(0,0,0,0.8)',
            cursor: 'pointer',
          }}
          onClick={handleConnect}
        >
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: touchMode ? 36 : 48, marginBottom: 16 }}>vibe-land</h1>
            <p style={{ fontSize: touchMode ? 18 : 20, opacity: 0.75 }}>
              {touchMode ? 'Tap anywhere to join' : 'Click anywhere to join'}
            </p>
            {touchMode && (
              <p style={{ marginTop: 12, fontSize: 14, opacity: 0.55 }}>
                Left thumb moves. Swipe on the right side to look.
              </p>
            )}
          </div>
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top) + 8px)',
          left: 'calc(env(safe-area-inset-left) + 8px)',
          right: touchMode ? 'calc(env(safe-area-inset-right) + 8px)' : 'auto',
          zIndex: 5,
          background: 'rgba(0,0,0,0.6)',
          padding: '4px 12px',
          borderRadius: 4,
          fontSize: touchMode ? 13 : 14,
          pointerEvents: 'none',
        }}
      >
        {status}
      </div>
      {connected && (
        <GameScene
          onWelcome={handleWelcome}
          onDisconnect={handleDisconnect}
          playerId={playerId}
        />
      )}
    </div>
  );
}
